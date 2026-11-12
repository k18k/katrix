import { isObject } from "../shared/json.js";
import { M, UNSTABLE } from "../shared/m.js";
import { splitStateKey, toClientEvent } from "../core/events.js";
import { MatrixError } from "../core/errors.js";
import { getState } from "../core/authrules.js";
import { v } from "../core/vpm.js";
import { body, lenient } from "../http/input.js";
import { procedure } from "../http/procedure.js";
import { longPoll } from "./longpoll.js";
import { roomEphemeral, roomTimeline, toStripped } from "./sync.js";
// src/api/slidingsync.ts
const slidingSyncBody = body({
	conn_id: lenient(v.string()),
	lists: lenient(v.record(v.string(), v.unknown())),
	room_subscriptions: lenient(v.record(v.string(), v.unknown())),
	extensions: lenient(v.record(v.string(), v.unknown()))
});
const BUMP_TYPES = /* @__PURE__ */ new Set([
	M.ROOM.CREATE,
	M.ROOM.MESSAGE,
	M.ROOM.ENCRYPTED,
	M.STICKER,
	M.CALL.INVITE,
	M.POLL.START,
	M.BEACON_INFO
]);
async function loadConnection(hs, s, connId) {
	return hs.db.findOne("sliding_sync_connections", [
		{
			field: "user_id",
			value: s.userId
		},
		{
			field: "device_id",
			value: s.deviceId
		},
		{
			field: "conn_id",
			value: connId
		}
	]);
}
/** Stream position of the latest "interesting" event in a room. */
async function bumpStamp(hs, roomId, upTo) {
	const rows = await hs.db.findMany("events", {
		where: [{
			field: "room_id",
			value: roomId
		}, {
			field: "stream",
			operator: "lte",
			value: upTo
		}],
		sortBy: {
			field: "stream",
			direction: "desc"
		},
		limit: 50
	});
	for (const r of rows) if (BUMP_TYPES.has(r.type)) return r.stream;
	return rows[rows.length - 1]?.stream ?? 0;
}
function matchesRequiredState(required, type, key, userId, lazyMembers) {
	for (const [t, k] of required) {
		if (t !== "*" && t !== type) continue;
		if (k === "*" || k === key) return true;
		if (k === "$ME" && key === userId) return true;
		if (k === "$LAZY" && type === M.ROOM.MEMBER && lazyMembers.has(key)) return true;
	}
	return false;
}
function registerSlidingSyncRoutes(r) {
	r.post("/_matrix/client/unstable/org.matrix.simplified_msc3575/sync", procedure({
		auth: "user",
		input: slidingSyncBody,
		handler: slidingSync
	}));
	r.post("/_matrix/client/v5/sync", procedure({
		auth: "user",
		input: slidingSyncBody,
		handler: slidingSync
	}));
}
async function slidingSync(ctx) {
	const hs = ctx.hs;
	const s = ctx.session;
	const body = ctx.input;
	const connId = body.conn_id ?? "";
	const posParam = ctx.query.get("pos");
	const timeout = Math.min(Math.max(Number.parseInt(ctx.query.get("timeout") ?? "0", 10) || 0, 0), hs.config.maxSyncTimeoutMs);
	let conn = {
		rooms: {},
		prevPos: null,
		toDeviceSince: 0
	};
	let since = null;
	if (posParam !== null) {
		const row = await loadConnection(hs, s, connId);
		const pos = Number(posParam);
		if (!row || !Number.isInteger(pos) || pos !== row.pos && pos !== row.state.prevPos) throw new MatrixError(400, "M_UNKNOWN_POS", "Unknown position; start a new connection");
		conn = row.state;
		since = pos;
		if (pos === row.state.prevPos && pos !== row.pos) conn = {
			...conn,
			rooms: {}
		};
	}
	const { value, to, aborted } = await longPoll(hs, s.userId, timeout, ctx.request.signal, async (to) => {
		const built = await buildResponse(hs, s, body, conn, since, to);
		return {
			value: built,
			done: since === null || !built.empty
		};
	});
	if (aborted && value.empty) return {
		pos: String(since),
		lists: {},
		rooms: {},
		extensions: {}
	};
	await hs.db.upsert("sliding_sync_connections", {
		user_id: s.userId,
		device_id: s.deviceId,
		conn_id: connId,
		pos: to,
		state: {
			...value.next,
			prevPos: since
		},
		updated_ts: Date.now()
	});
	return {
		pos: String(to),
		...value.response
	};
}
async function buildResponse(hs, s, body, conn, since, to) {
	const userId = s.userId;
	const memberships = await hs.db.findMany("memberships", { where: [{
		field: "user_id",
		value: userId
	}] });
	const direct = await hs.db.findOne("account_data", [
		{
			field: "user_id",
			value: userId
		},
		{
			field: "room_id",
			value: ""
		},
		{
			field: "type",
			value: M.DIRECT
		}
	]);
	const dmRooms = new Set(Object.values(direct?.content ?? {}).flat().filter((x) => typeof x === "string"));
	const candidates = memberships.filter((m) => m.stream <= to && ([
		"join",
		"invite",
		"knock"
	].includes(m.membership) || since !== null && m.stream > since && !m.forgotten));
	const infos = [];
	for (const m of candidates) {
		const state = await hs.rooms.currentState(m.room_id);
		const bump = m.membership === "join" ? await bumpStamp(hs, m.room_id, to) : m.stream;
		infos.push({
			roomId: m.room_id,
			membership: m.membership,
			bump,
			state
		});
		const invite = getState(state, M.ROOM.MEMBER, userId);
		if (m.membership === "invite" && invite?.content?.is_direct) dmRooms.add(m.room_id);
	}
	infos.sort((a, b) => b.bump - a.bump);
	const wanted = /* @__PURE__ */ new Map();
	const lists = {};
	for (const [name, raw] of Object.entries(isObject(body.lists) ? body.lists : {})) {
		const list = raw;
		const f = list.filters ?? {};
		let rooms = infos;
		if (f.is_dm !== void 0) rooms = rooms.filter((r) => dmRooms.has(r.roomId) === f.is_dm);
		if (f.is_invite !== void 0) rooms = rooms.filter((r) => r.membership === "invite" === f.is_invite);
		if (f.is_encrypted !== void 0) rooms = rooms.filter((r) => !!getState(r.state, M.ROOM.ENCRYPTION) === f.is_encrypted);
		const roomType = (r) => getState(r.state, M.ROOM.CREATE)?.content?.type ?? null;
		if (f.room_types) rooms = rooms.filter((r) => f.room_types.includes(roomType(r)));
		if (f.not_room_types) rooms = rooms.filter((r) => !f.not_room_types.includes(roomType(r)));
		if (f.spaces) {
			const children = /* @__PURE__ */ new Set();
			for (const space of f.spaces) {
				if (!await hs.rooms.exists(space)) continue;
				for (const key of (await hs.rooms.currentState(space)).keys()) {
					const [t, k] = splitStateKey(key);
					if (t === M.SPACE.CHILD) children.add(k);
				}
			}
			rooms = rooms.filter((r) => children.has(r.roomId));
		}
		lists[name] = { count: rooms.length };
		for (const [start, end] of list.ranges ?? [[0, rooms.length - 1]]) for (const room of rooms.slice(Math.max(0, start), Math.max(0, end) + 1)) {
			const prev = wanted.get(room.roomId);
			wanted.set(room.roomId, mergeConfig(prev, list));
		}
	}
	for (const [roomId, raw] of Object.entries(isObject(body.room_subscriptions) ? body.room_subscriptions : {})) {
		if (!infos.find((i) => i.roomId === roomId)) {
			if (!await hs.rooms.exists(roomId) || !(await hs.rooms.canPeek(roomId, userId)).worldReadable) continue;
			infos.push({
				roomId,
				membership: "leave",
				bump: 0,
				state: await hs.rooms.currentState(roomId)
			});
		}
		wanted.set(roomId, mergeConfig(wanted.get(roomId), raw));
	}
	const next = {
		rooms: { ...conn.rooms },
		prevPos: conn.prevPos,
		toDeviceSince: conn.toDeviceSince
	};
	const rooms = {};
	for (const [roomId, config] of wanted) {
		const info = infos.find((i) => i.roomId === roomId);
		const configKey = JSON.stringify(config);
		const known = since !== null ? conn.rooms[roomId] : void 0;
		const initial = !known || known.config !== configKey;
		const room = await buildRoom(hs, s, info, config, initial ? null : since, to, dmRooms.has(roomId));
		const counts = JSON.stringify([
			room.notification_count,
			room.highlight_count,
			room.joined_count,
			room.invited_count
		]);
		if (!initial && room.timeline.length === 0 && room.required_state.length === 0 && known.counts === counts) continue;
		if (initial) room.initial = true;
		if (since !== null && !initial) room.num_live = room.timeline.filter((e) => e.__stream > since).length;
		for (const e of room.timeline) delete e.__stream;
		rooms[roomId] = room;
		next.rooms[roomId] = {
			config: configKey,
			counts
		};
	}
	const extensions = await buildExtensions(hs, s, body.extensions ?? {}, since, to, Object.keys(rooms), next);
	const empty = Object.keys(rooms).length === 0 && Object.values(extensions).every((e) => isEmptyExtension(e));
	return {
		response: {
			lists,
			rooms,
			extensions
		},
		empty,
		next
	};
}
function mergeConfig(a, b) {
	if (!a) return {
		required_state: b.required_state ?? [],
		timeline_limit: b.timeline_limit ?? 0
	};
	return {
		required_state: [...a.required_state ?? [], ...b.required_state ?? []],
		timeline_limit: Math.max(a.timeline_limit ?? 0, b.timeline_limit ?? 0)
	};
}
async function buildRoom(hs, s, info, config, since, to, isDm) {
	const { roomId, state } = info;
	const userId = s.userId;
	const room = {
		bump_stamp: info.bump,
		timeline: [],
		required_state: []
	};
	const name = getState(state, M.ROOM.NAME)?.content?.name;
	if (typeof name === "string") room.name = name;
	const avatar = getState(state, M.ROOM.AVATAR)?.content?.url;
	if (typeof avatar === "string") room.avatar = avatar;
	if (isDm) room.is_dm = true;
	if (info.membership === "invite" || info.membership === "knock") {
		const own = getState(state, M.ROOM.MEMBER, userId);
		const ev = own?.event_id ? await hs.rooms.getEvent(own.event_id) : null;
		if (ev) {
			const key = info.membership === "invite" ? "invite_room_state" : "knock_room_state";
			room[info.membership === "invite" ? "invite_state" : "knock_state"] = [...ev.pdu.unsigned?.[key] ?? [], ev.pdu].map(toStripped);
		}
		return room;
	}
	const p = {
		session: s,
		ignored: /* @__PURE__ */ new Set(),
		since: since === null ? null : {
			pos: since,
			toDevice: 0
		},
		to,
		filter: { room: { timeline: { limit: config.timeline_limit ?? 0 } } },
		fullState: false
	};
	const upTo = info.membership === "join" ? to : Math.min(to, (await hs.db.findOne("memberships", [{
		field: "room_id",
		value: roomId
	}, {
		field: "user_id",
		value: userId
	}]))?.stream ?? to);
	if ((config.timeline_limit ?? 0) > 0) {
		const { timeline, timelineEvents } = await roomTimeline(hs, p, roomId, since, upTo);
		room.timeline = timeline.events.map((e, i) => ({
			...e,
			room_id: void 0,
			__stream: timelineEvents[i].stream
		}));
		room.limited = timeline.limited;
		room.prev_batch = timeline.prev_batch;
	}
	const lazy = /* @__PURE__ */ new Set([userId, ...room.timeline.map((e) => e.sender)]);
	const required = config.required_state ?? [];
	for (const [key, ev] of state) {
		const [type, sk] = splitStateKey(key);
		if (!matchesRequiredState(required, type, sk, userId, lazy)) continue;
		if (since !== null) {
			const stored = ev.event_id ? await hs.rooms.getEvent(ev.event_id) : null;
			if (!stored || stored.stream <= since) continue;
		}
		room.required_state.push(toClientEvent(ev, { includeRoomId: false }));
	}
	let joined = 0;
	let invited = 0;
	const heroes = [];
	for (const [key, ev] of state) {
		const [type, sk] = splitStateKey(key);
		if (type !== M.ROOM.MEMBER) continue;
		const m = ev.content?.membership;
		if (m === "join") joined++;
		if (m === "invite") invited++;
		if ((m === "join" || m === "invite") && sk !== userId && heroes.length < 5) heroes.push({
			user_id: sk,
			displayname: ev.content?.displayname,
			avatar_url: ev.content?.avatar_url
		});
	}
	room.joined_count = joined;
	room.invited_count = invited;
	if (!room.name) room.heroes = heroes;
	const counts = await hs.push.unreadCounts(userId, roomId);
	room.notification_count = counts.room.notification_count + Object.values(counts.threads).reduce((n, t) => n + t.notification_count, 0);
	room.highlight_count = counts.room.highlight_count + Object.values(counts.threads).reduce((n, t) => n + t.highlight_count, 0);
	return room;
}
async function buildExtensions(hs, s, ext, since, to, roomIds, next) {
	const out = {};
	const userId = s.userId;
	if (ext.to_device?.enabled) {
		const where = [{
			field: "user_id",
			value: userId
		}, {
			field: "device_id",
			value: s.deviceId
		}];
		const ackUpTo = Number(ext.to_device.since ?? next.toDeviceSince) || 0;
		if (ackUpTo) await hs.db.delete("to_device", [...where, {
			field: "stream",
			operator: "lte",
			value: ackUpTo
		}]);
		const rows = (await hs.db.findMany("to_device", {
			where: [...where, {
				field: "stream",
				operator: "gt",
				value: ackUpTo
			}],
			sortBy: {
				field: "stream",
				direction: "asc"
			},
			limit: Math.min(Number(ext.to_device.limit ?? 100) || 100, 1e3)
		})).filter((r) => r.stream <= to);
		const nextBatch = rows.length ? rows[rows.length - 1].stream : ackUpTo;
		next.toDeviceSince = nextBatch;
		out.to_device = {
			next_batch: String(nextBatch),
			events: rows.map((r) => ({
				sender: r.sender,
				type: r.type,
				content: r.content
			}))
		};
	}
	if (ext.e2ee?.enabled) {
		const e2ee = {
			device_one_time_keys_count: await hs.keys.oneTimeKeyCounts(userId, s.deviceId),
			device_unused_fallback_key_types: await hs.keys.unusedFallbackKeyTypes(userId, s.deviceId)
		};
		if (since !== null) e2ee.device_lists = await hs.keys.changesSince(userId, since, to);
		out.e2ee = e2ee;
	}
	if (ext.account_data?.enabled) {
		const where = [{
			field: "user_id",
			value: userId
		}];
		if (since !== null) where.push({
			field: "stream",
			operator: "gt",
			value: since
		});
		const rows = (await hs.db.findMany("account_data", { where })).filter((r) => r.stream <= to);
		const rooms = {};
		const global = [];
		for (const r of rows) {
			const ev = {
				type: r.type,
				content: r.content
			};
			if (r.room_id === "") global.push(ev);
			else if (roomIds.includes(r.room_id) || since !== null) (rooms[r.room_id] ??= []).push(ev);
		}
		if (since === null && !global.some((e) => e.type === M.PUSH_RULES)) {
			const { readOnlyRules } = await import("../core/pushrules.js");
			global.push({
				type: M.PUSH_RULES,
				content: { global: await readOnlyRules(hs, userId) }
			});
		}
		out.account_data = {
			global,
			rooms
		};
	}
	if (ext[UNSTABLE.IO.ELEMENT.MSC4308.THREAD_SUBSCRIPTIONS]?.enabled) {
		const { threadSubscriptionsExtension } = await import("./threadsubs.js");
		out[UNSTABLE.IO.ELEMENT.MSC4308.THREAD_SUBSCRIPTIONS] = await threadSubscriptionsExtension(hs, userId, ext[UNSTABLE.IO.ELEMENT.MSC4308.THREAD_SUBSCRIPTIONS], since, to);
	}
	if (ext.receipts?.enabled || ext.typing?.enabled) {
		const p = {
			session: s,
			ignored: /* @__PURE__ */ new Set(),
			since: since === null ? null : {
				pos: since,
				toDevice: 0
			},
			to,
			filter: {},
			fullState: false
		};
		const receipts = {};
		const typing = {};
		const joined = new Set(await hs.rooms.roomsForUser(userId));
		for (const roomId of since === null ? roomIds : [...joined]) {
			if (!joined.has(roomId)) continue;
			for (const e of await roomEphemeral(hs, p, roomId)) {
				if (e.type === M.RECEIPT && ext.receipts?.enabled) receipts[roomId] = e;
				if (e.type === M.TYPING && ext.typing?.enabled && (since !== null || e.content.user_ids.length)) typing[roomId] = e;
			}
		}
		if (ext.receipts?.enabled) out.receipts = { rooms: receipts };
		if (ext.typing?.enabled) out.typing = { rooms: typing };
	}
	return out;
}
function isEmptyExtension(e) {
	if (Array.isArray(e.events)) return e.events.length === 0;
	if (e.rooms && Object.keys(e.rooms).length) return false;
	if (e.global && e.global.length) return false;
	if (e.device_lists && (e.device_lists.changed.length || e.device_lists.left.length)) return false;
	return true;
}
export { registerSlidingSyncRoutes };

//# sourceMappingURL=slidingsync.js.map