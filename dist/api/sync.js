import { M, UNSTABLE } from "../packages/shared/src/m.js";
import { errors } from "../core/errors.js";
import { getState } from "../core/authrules.js";
import { eventIdOf, previousMembership, splitStateKey, stateKey, strippedState, toClientEvent } from "../core/events.js";
import { readBatch } from "../storage/batch.js";
import { trackedReads } from "../core/changes.js";
import { Semaphore } from "../core/semaphore.js";
import { longPoll } from "./longpoll.js";
import { deviceListChangesQuery } from "../core/keys.js";
import { procedure } from "../http/procedure.js";
import { body } from "../http/input.js";
import { matchesFilter, roomAllowed, validateSyncFilter } from "./filters.js";
import { readOnlyRules } from "../core/pushrules.js";
import { fullProfile } from "../core/profile.js";
import { inviteDecision } from "../core/invitefilter.js";
// src/api/sync.ts
function parseSyncToken(raw) {
	if (!raw) return null;
	const m = /^s(\d+)(?:_(\d+))?(_a)?$/.exec(raw);
	if (!m) throw errors.invalidParam("Invalid since token");
	return {
		pos: Number(m[1]),
		toDevice: Number(m[2] ?? m[1]),
		ack: !!m[3]
	};
}
const formatToken = (t) => `s${t.pos}_${t.toDevice}${t.ack ? "_a" : ""}`;
async function loadFilter(hs, userId, raw) {
	if (!raw) return {};
	if (raw.trim().startsWith("{")) {
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw errors.badJson("Invalid filter JSON");
		}
		return validateSyncFilter(parsed);
	}
	const row = await hs.db.findOne("filters", [{
		field: "user_id",
		value: userId
	}, {
		field: "filter_id",
		value: raw
	}]);
	if (!row) throw errors.notFound("Unknown filter");
	return row.filter;
}
/** A stripped state event as clients expect it. */
function toStripped(ev) {
	return {
		type: ev.type,
		state_key: ev.state_key ?? "",
		sender: ev.sender,
		content: ev.content
	};
}
/** State snapshot ID in effect at stream position `pos` in a room (0 = empty). */
async function snapshotAt(hs, roomId, pos) {
	return (await hs.db.findMany("events", {
		where: [{
			field: "room_id",
			value: roomId
		}, {
			field: "stream",
			operator: "lte",
			value: pos
		}],
		sortBy: {
			field: "stream",
			direction: "desc"
		},
		limit: 1,
		fields: ["state_snapshot"]
	}))[0]?.state_snapshot ?? 0;
}
/** Build the timeline + state section of a room. */
async function roomTimeline(hs, p, roomId, since, upTo) {
	const tf = p.filter.room?.timeline;
	const limit = tf?.limit ?? 10;
	const where = [{
		field: "room_id",
		value: roomId
	}, {
		field: "stream",
		operator: "lte",
		value: upTo
	}];
	if (since !== null) where.push({
		field: "stream",
		operator: "gt",
		value: since
	});
	const sinceIdsRead = since !== null ? snapshotAt(hs, roomId, since).then((id) => hs.rooms.snapshotIds(id)) : Promise.resolve({});
	const scanned = [];
	const events = [];
	let limited = false;
	let cursor = upTo;
	const batchSize = Math.max(limit * 2, 20);
	for (;;) {
		const w = where.map((c) => c.field === "stream" && c.operator === "lte" ? {
			...c,
			value: cursor
		} : c);
		const rows = await hs.db.findMany("events", {
			where: w,
			sortBy: {
				field: "stream",
				direction: "desc"
			},
			limit: batchSize
		});
		if (rows.length === 0) break;
		scanned.push(...rows);
		const stored = rows.map((r) => hs.rooms.rowToStored(r));
		const visible = await hs.rooms.filterVisible(p.session.userId, roomId, stored);
		const ok = new Map(visible.map((v) => [v.pdu.event_id, v]));
		let full = false;
		for (const raw of stored) {
			cursor = raw.stream - 1;
			const ev = ok.get(raw.pdu.event_id);
			if (!ev || !matchesFilter(tf, ev.pdu) || p.ignored.has(ev.pdu.sender)) continue;
			if (events.length >= (since === null ? limit * 2 : limit)) {
				limited = true;
				full = true;
				break;
			}
			events.push(ev);
		}
		if (full || rows.length < batchSize) break;
	}
	if (since === null && events.length > limit) {
		events.sort((a, b) => (b.pdu.depth ?? 0) - (a.pdu.depth ?? 0) || b.stream - a.stream);
		events.length = limit;
		limited = true;
	}
	if (limit === 0 && events.length === 0) limited = (await hs.db.findMany("events", {
		where,
		limit: 1,
		fields: ["stream"]
	})).length > 0;
	if (since === null) events.sort((a, b) => (a.pdu.depth ?? 0) - (b.pdu.depth ?? 0) || a.stream - b.stream);
	else events.reverse();
	let lastGap = -1;
	events.forEach((e, i) => {
		if (e.gap) lastGap = i;
	});
	if (lastGap >= 0) {
		events.splice(0, lastGap);
		limited = true;
	}
	const startPos = events.length ? Math.min(...events.map((e) => e.stream)) - 1 : upTo;
	const newestAtOrBefore = async (pos) => {
		const row = scanned.find((r) => r.stream <= pos);
		if (row) return row;
		return (await hs.db.findMany("events", {
			where: [{
				field: "room_id",
				value: roomId
			}, {
				field: "stream",
				operator: "lte",
				value: pos
			}],
			sortBy: {
				field: "stream",
				direction: "desc"
			},
			limit: 1,
			fields: ["stream", "state_snapshot"]
		}))[0] ?? null;
	};
	const [atStart, atEnd] = await Promise.all([newestAtOrBefore(startPos), startPos === upTo ? null : newestAtOrBefore(upTo)]);
	const startSnapshot = atStart?.state_snapshot ?? 0;
	const endSnapshot = startPos === upTo ? startSnapshot : atEnd?.state_snapshot ?? 0;
	if (!limited && events.length) {
		if (events[0].stream === startPos + 1) limited = atStart !== null && (since === null || atStart.stream > since);
		else limited = (await hs.db.findMany("events", {
			where: [...where.filter((c) => c.operator !== "lte"), {
				field: "stream",
				operator: "lt",
				value: events[0].stream
			}],
			limit: 1,
			fields: ["stream"]
		})).length > 0;
	}
	const [startState, endState] = await Promise.all([hs.rooms.stateAtSnapshot(startSnapshot), hs.rooms.stateAtSnapshot(endSnapshot)]);
	const timelineIds = new Set(events.map((e) => e.pdu.event_id));
	for (const [key, ev] of endState) {
		if (timelineIds.has(ev.event_id) || startState.get(key)?.event_id === ev.event_id) continue;
		if (events.some((e) => e.pdu.state_key !== void 0 && stateKey(e.pdu.type, e.pdu.state_key) === key)) continue;
		startState.set(key, ev);
	}
	const sinceIds = await sinceIdsRead;
	const sf = p.filter.room?.state;
	const lazy = !!sf?.lazy_load_members;
	const senders = new Set(events.map((e) => e.pdu.sender));
	senders.add(p.session.userId);
	const state = [];
	for (const [key, ev] of startState) {
		if (sinceIds[key] === ev.event_id) continue;
		const [type, sk] = splitStateKey(key);
		if (!matchesFilter(sf, ev)) continue;
		if (lazy && type === M.ROOM.MEMBER && !senders.has(sk)) continue;
		state.push(ev);
	}
	if (lazy) for (const e of events) {
		const key = stateKey(M.ROOM.MEMBER, e.pdu.sender);
		if (startState.has(key) || state.some((s) => s.type === M.ROOM.MEMBER && s.state_key === e.pdu.sender)) continue;
		const member = [...(await hs.rooms.getPdus((e.pdu.auth_events ?? []).map(eventIdOf))).values()].find((a) => a.type === M.ROOM.MEMBER && a.state_key === e.pdu.sender);
		if (member && matchesFilter(sf, member)) state.push(member);
	}
	const stateAfter = [];
	if (p.useStateAfter) for (const [key, ev] of endState) {
		if (sinceIds[key] === ev.event_id) continue;
		const [type, sk] = splitStateKey(key);
		if (!matchesFilter(sf, ev)) continue;
		if (lazy && type === M.ROOM.MEMBER && !senders.has(sk)) continue;
		stateAfter.push(ev);
	}
	return {
		stateAfter,
		timeline: {
			events: events.map((e) => hs.rooms.formatEvent(e, p.session, { includeRoomId: false })),
			limited,
			prev_batch: `s${startPos}`
		},
		state,
		timelineEvents: events
	};
}
async function roomEphemeral(hs, p, roomId, prefetched) {
	const since = p.since?.pos ?? null;
	const typing = hs.typing.typingSince(roomId, since);
	const where = [{
		field: "room_id",
		value: roomId
	}];
	if (since !== null) where.push({
		field: "stream",
		operator: "gt",
		value: since
	});
	const receipts = (prefetched ?? await hs.db.findMany("receipts", { where })).filter((r) => r.stream <= p.to);
	/** By event, receipt type and user. */
	const content = {};
	for (const r of receipts) {
		if (r.receipt_type === M.READ.PRIVATE && r.user_id !== p.session.userId) continue;
		const users = (content[r.event_id] ??= {})[r.receipt_type] ??= {};
		if (r.thread_id && users[r.user_id] && !users[r.user_id].thread_id) continue;
		users[r.user_id] = {
			ts: r.ts,
			...r.thread_id ? { thread_id: r.thread_id } : {}
		};
	}
	return [...typing !== null && (since !== null || typing.length > 0) ? [{
		type: M.TYPING,
		content: { user_ids: typing }
	}] : [], ...Object.keys(content).length ? [{
		type: M.RECEIPT,
		content
	}] : []].filter((e) => matchesFilter(p.filter.room?.ephemeral, e));
}
async function accountData(hs, p, roomId, prefetched) {
	const where = [{
		field: "user_id",
		value: p.session.userId
	}, {
		field: "room_id",
		value: roomId
	}];
	if (p.since && !p.fullState) where.push({
		field: "stream",
		operator: "gt",
		value: p.since.pos
	});
	const rows = prefetched ?? await hs.db.findMany("account_data", { where });
	const filter = roomId ? p.filter.room?.account_data : p.filter.account_data;
	return rows.filter((r) => r.stream <= p.to && (p.since || Object.keys(r.content ?? {}).length > 0)).map((r) => ({
		type: r.type,
		content: r.content
	})).filter((e) => matchesFilter(filter, e));
}
/** The state events a room summary is computed from: members for the counts and heroes, the name and alias for whether heroes are needed. */
const SUMMARY_TYPES = /* @__PURE__ */ new Set([
	M.ROOM.MEMBER,
	M.ROOM.NAME,
	M.ROOM.CANONICAL_ALIAS
]);
/**
* What a room's summary is made of, by state map: the room service replaces a room's map when its state changes, so a
* map's members never change. A join wakes every member of the room, and each of their syncs needed the same lists.
*/
const summaryParts = /* @__PURE__ */ new WeakMap();
function summaryPartsOf(state) {
	const known = summaryParts.get(state);
	if (known) return known;
	let joined = 0;
	let invited = 0;
	/** Joined and invited members, in state order: the first of them become the heroes. */
	const members = [];
	for (const [key, ev] of state) {
		const [type, sk] = splitStateKey(key);
		if (type !== M.ROOM.MEMBER) continue;
		const m = ev.content?.membership;
		if (m === "join") joined++;
		if (m === "invite") invited++;
		if (m === "join" || m === "invite") members.push(sk);
	}
	const named = !!(getState(state, M.ROOM.NAME)?.content?.name || getState(state, M.ROOM.CANONICAL_ALIAS)?.content?.alias);
	const parts = {
		joined,
		invited,
		members,
		named
	};
	summaryParts.set(state, parts);
	return parts;
}
async function roomSummary(hs, roomId, userId) {
	const { joined, invited, members, named } = summaryPartsOf(await hs.rooms.currentState(roomId));
	const counts = {
		[M.JOINED_MEMBER_COUNT]: joined,
		[M.INVITED_MEMBER_COUNT]: invited
	};
	if (named) return counts;
	const heroes = [];
	for (const m of members) {
		if (heroes.length === 5) break;
		if (m !== userId) heroes.push(m);
	}
	return {
		...counts,
		[M.HEROES]: heroes.sort()
	};
}
/**
* What changed for the user since the token, for all of their rooms at once: the rooms with new
* events or newly complete state, and the new receipts and account data by room.
*
* https://github.com/k18k/katrix/issues/33: an incremental sync queried every
* joined room (timeline, receipts, account data) and only then found that most had nothing new,
* so a sync cost as many queries as the user had rooms, each time a long-poll woke up. These few
* queries find the rooms that changed, and only those are built.
*/
/** One-time key counts by algorithm, as /sync reports them (signed_curve25519 always present). */
function countAlgorithms(rows) {
	const counts = { signed_curve25519: 0 };
	for (const r of rows) counts[r.algorithm] = (counts[r.algorithm] ?? 0) + 1;
	return counts;
}
async function changesSince(hs, p, memberships, since, accountRows) {
	const joined = memberships.filter((m) => m.membership === "join").map((m) => m.room_id);
	const anyMembership = [...new Set(memberships.map((m) => m.room_id))];
	const range = [{
		field: "stream",
		operator: "gt",
		value: since
	}, {
		field: "stream",
		operator: "lte",
		value: p.to
	}];
	const logs = hs.changes?.logs;
	const mayHaveChanged = (log, rooms) => logs ? logs[log].filterChanged(rooms, since) : rooms;
	const chunks = (list) => Array.from({ length: Math.ceil(list.length / 500) }, (_, i) => list.slice(i * 500, i * 500 + 500));
	const inRooms = (chunk) => ({
		field: "room_id",
		operator: "in",
		value: chunk
	});
	const queries = [];
	const kinds = [];
	const add = (kind, query) => {
		kinds.push(kind);
		queries.push(query);
	};
	const eventRooms = mayHaveChanged("roomEvents", joined);
	const knownEventRooms = logs?.roomEvents.knowsAfter(since) ? eventRooms : [];
	if (!knownEventRooms.length) for (const chunk of chunks(eventRooms)) add("events", {
		model: "events",
		opts: {
			where: [inRooms(chunk), ...range],
			fields: ["room_id"]
		}
	});
	for (const chunk of chunks(mayHaveChanged("roomReceipts", joined))) add("receipts", {
		model: "receipts",
		opts: { where: [inRooms(chunk), ...range] }
	});
	for (const chunk of chunks(mayHaveChanged("roomPartialState", joined))) add("completed", {
		model: "partial_state_rooms",
		opts: {
			where: [inRooms(chunk), {
				field: "completed_stream",
				operator: "gt",
				value: since
			}],
			fields: ["room_id"]
		}
	});
	for (const chunk of chunks(mayHaveChanged("roomMembers", anyMembership))) add("members", {
		model: "memberships",
		opts: { where: [inRooms(chunk), {
			field: "stream",
			operator: "gt",
			value: since
		}] }
	});
	const results = queries.length ? await readBatch(hs.db, queries) : [];
	const touched = new Set(knownEventRooms);
	const receipts = /* @__PURE__ */ new Map();
	const memberChanges = [];
	results.forEach((rows, i) => {
		const kind = kinds[i];
		for (const r of rows) {
			if (kind === "members") memberChanges.push(r);
			else touched.add(r.room_id);
			if (kind === "receipts") receipts.set(r.room_id, [...receipts.get(r.room_id) ?? [], r]);
		}
	});
	const accountData = /* @__PURE__ */ new Map();
	for (const r of accountRows) {
		if (r.room_id) touched.add(r.room_id);
		accountData.set(r.room_id, [...accountData.get(r.room_id) ?? [], r]);
	}
	return {
		touched,
		receipts,
		accountData,
		memberChanges
	};
}
/** Presence or device-list changes after a token read without a user filter, at most (#44). */
const RECENT_CHANGES = 500;
/** How many of a sync's joined rooms are built at once (#38). */
const JOINED_ROOMS_AT_ONCE = 8;
/** `fn` over `items` with at most `limit` running at once; results in input order. */
async function mapConcurrently(items, limit, fn) {
	const out = [];
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}
async function buildSync(hs, p) {
	const userId = p.session.userId;
	const since = p.since?.pos ?? null;
	const incremental = since !== null && !p.fullState;
	const deviceWhere = [{
		field: "user_id",
		value: userId
	}, {
		field: "device_id",
		value: p.session.deviceId
	}];
	const acknowledged = p.since?.ack ? hs.db.delete("to_device", [...deviceWhere, {
		field: "stream",
		operator: "lte",
		value: p.since.toDevice
	}]) : Promise.resolve(0);
	const device = `${userId}|${p.session.deviceId}`;
	const [memberships, ignoredRows, toDeviceRows, oneTimeKeyRows, fallbackRows, accountRows = []] = await trackedReads(hs.db, hs.changes, [
		{
			query: {
				model: "memberships",
				opts: { where: [{
					field: "user_id",
					value: userId
				}] }
			},
			cached: {
				name: "userMemberships",
				key: userId
			}
		},
		{
			query: {
				model: "account_data",
				opts: { where: [
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
						value: M.IGNORED_USER_LIST
					}
				] }
			},
			cached: {
				name: "ignoredUsers",
				key: userId
			}
		},
		{
			query: {
				model: "to_device",
				opts: {
					where: [...deviceWhere, {
						field: "stream",
						operator: "gt",
						value: p.since?.toDevice ?? 0
					}],
					sortBy: {
						field: "stream",
						direction: "asc"
					},
					limit: 100
				}
			},
			unlessChanged: {
				log: "toDevice",
				key: device,
				after: p.since?.toDevice ?? 0
			}
		},
		{
			query: {
				model: "one_time_keys",
				opts: {
					where: [...deviceWhere, {
						field: "fallback",
						value: false
					}],
					fields: ["algorithm"]
				}
			},
			cached: {
				name: "oneTimeKeys",
				key: device
			}
		},
		{
			query: {
				model: "fallback_keys",
				opts: {
					where: [...deviceWhere, {
						field: "used",
						value: false
					}],
					fields: ["algorithm"]
				}
			},
			cached: {
				name: "fallbackKeys",
				key: device
			}
		},
		...incremental ? [{
			query: {
				model: "account_data",
				opts: { where: [{
					field: "user_id",
					value: userId
				}, {
					field: "stream",
					operator: "gt",
					value: since
				}] }
			},
			unlessChanged: {
				log: "accountData",
				key: userId,
				after: since
			}
		}] : []
	]);
	p = {
		...p,
		ignored: new Set(Object.keys(ignoredRows[0]?.content?.ignored_users ?? {}))
	};
	const changes = incremental ? await changesSince(hs, p, memberships, since, accountRows) : null;
	let memberChangesRead = changes ? Promise.resolve(changes.memberChanges) : null;
	const memberChanges = () => memberChangesRead ??= hs.rooms.membershipChangesSince(userId, since ?? 0, memberships);
	const join = {};
	const invite = {};
	const leave = {};
	const knock = {};
	let empty = true;
	const joinedBuilds = [];
	for (const m of memberships) {
		if (m.stream > p.to || !roomAllowed(p.filter, m.room_id)) continue;
		const roomId = m.room_id;
		const changed = since === null || m.stream > since;
		if (m.membership === "join") {
			if (changes && !changed && !changes.touched.has(roomId) && hs.typing.typingSince(roomId, since) === null) continue;
			joinedBuilds.push(m);
		} else if (m.membership === "invite") {
			if (!changed && !p.fullState) continue;
			const pdu = await hs.rooms.getPdu(m.event_id);
			if (!pdu || p.ignored.has(pdu.sender)) continue;
			if (await inviteDecision(hs, userId, pdu.sender) !== "allow") continue;
			invite[roomId] = { invite_state: { events: [...strippedState(pdu, "invite_room_state"), toStripped(pdu)] } };
			empty = false;
		} else if (m.membership === "knock") {
			if (!changed && !p.fullState) continue;
			const knockPdu = await hs.rooms.getPdu(m.event_id);
			const ev = knockPdu ? { pdu: knockPdu } : null;
			if (!ev) continue;
			knock[roomId] = { knock_state: { events: [...strippedState(ev.pdu, "knock_room_state"), toStripped(ev.pdu)] } };
			empty = false;
		} else {
			if (m.forgotten && since === null) continue;
			if (since === null ? !p.filter.room?.include_leave : m.stream <= since) continue;
			const { timeline, state } = await roomTimeline(hs, p, roomId, since, m.stream);
			const tf = p.filter.room?.timeline;
			if (!await hs.rooms.exists(roomId) && (tf?.limit ?? 10) > 0 && !timeline.events.some((e) => e.event_id === m.event_id)) {
				const leavePdu = await hs.rooms.getPdu(m.event_id);
				if (leavePdu && matchesFilter(tf, leavePdu)) timeline.events.push(toClientEvent(leavePdu, { includeRoomId: false }));
			}
			leave[roomId] = {
				timeline,
				state: { events: state.map((e) => toClientEvent(e, { includeRoomId: false })) },
				account_data: { events: await accountData(hs, p, roomId, changes ? changes.accountData.get(roomId) ?? [] : void 0) }
			};
			empty = false;
		}
	}
	const joinedRoom = async (m) => {
		const roomId = m.room_id;
		if (!p.filter.room?.state?.lazy_load_members && await hs.partialState.isPartial(roomId)) return null;
		const completedAt = await hs.partialState.completedAt(roomId);
		const initial = since === null || p.fullState || m.stream > since || completedAt !== null && completedAt > since && completedAt <= p.to;
		const summaryRead = initial ? roomSummary(hs, roomId, userId) : null;
		const [{ timeline, state, stateAfter, timelineEvents }, ephemeral, roomAccountData, counts] = await Promise.all([
			roomTimeline(hs, p, roomId, initial ? null : since, p.to),
			roomEphemeral(hs, p, roomId, changes ? changes.receipts.get(roomId) ?? [] : void 0),
			accountData(hs, p, roomId, changes ? changes.accountData.get(roomId) ?? [] : void 0),
			hs.push.unreadCounts(userId, roomId)
		]);
		if (!initial && timelineEvents.length === 0 && state.length === 0 && stateAfter.length === 0 && ephemeral.length === 0 && roomAccountData.length === 0) return null;
		const stateSection = p.useStateAfter ? { [p.stateAfterKey ?? "state_after"]: { events: stateAfter.map((e) => toClientEvent(e, { includeRoomId: false })) } } : { state: { events: state.map((e) => toClientEvent(e, { includeRoomId: false })) } };
		const changesSummary = (e) => e.state_key !== void 0 && SUMMARY_TYPES.has(e.type);
		const summaryChanged = [
			...state,
			...stateAfter,
			...timelineEvents.map((e) => e.pdu)
		].some(changesSummary);
		const summary = summaryRead ? await summaryRead : summaryChanged ? await roomSummary(hs, roomId, userId) : void 0;
		const room = {
			timeline,
			...stateSection,
			ephemeral: { events: ephemeral },
			account_data: { events: roomAccountData },
			...summary ? { summary } : {}
		};
		if (p.filter.room?.timeline?.unread_thread_notifications) {
			room.unread_notifications = counts.room;
			if (Object.keys(counts.threads).length) room.unread_thread_notifications = counts.threads;
		} else {
			const total = { ...counts.room };
			for (const t of Object.values(counts.threads)) {
				total.notification_count += t.notification_count;
				total.highlight_count += t.highlight_count;
			}
			room.unread_notifications = total;
		}
		return room;
	};
	const built = await mapConcurrently(joinedBuilds, JOINED_ROOMS_AT_ONCE, joinedRoom);
	joinedBuilds.forEach((m, i) => {
		if (!built[i]) return;
		join[m.room_id] = built[i];
		empty = false;
	});
	const globalAccountData = await accountData(hs, p, "", changes ? changes.accountData.get("") ?? [] : void 0);
	if (since === null && !globalAccountData.some((e) => e.type === M.PUSH_RULES)) globalAccountData.push({
		type: M.PUSH_RULES,
		content: { global: await readOnlyRules(hs, userId) }
	});
	if (globalAccountData.length) empty = false;
	await acknowledged;
	const toDevice = toDeviceRows.filter((r) => r.stream <= p.to);
	const nextToDevice = toDevice.length ? toDevice[toDevice.length - 1].stream : p.since?.toDevice ?? 0;
	if (toDevice.length) empty = false;
	const presenceEvents = [];
	const wantPresence = !p.filter.presence?.types || p.filter.presence.types.length > 0;
	const sharing = await hs.rooms.usersSharingRooms(userId);
	const joinedRooms = memberships.filter((m) => m.membership === "join").map((m) => m.room_id);
	const newlyShared = /* @__PURE__ */ new Set();
	if (since !== null && wantPresence) {
		const myRooms = new Set(joinedRooms);
		for (const c of await memberChanges()) {
			if (c.membership !== "join" || !myRooms.has(c.room_id)) continue;
			if (c.user_id === userId) for (const u of await hs.rooms.joinedMembers(c.room_id)) newlyShared.add(u);
			else newlyShared.add(c.user_id);
		}
	}
	const sharingList = [...sharing];
	const recent = (model) => ({
		model,
		opts: {
			where: [{
				field: "stream",
				operator: "gt",
				value: since
			}],
			sortBy: {
				field: "stream",
				direction: "asc"
			},
			limit: 501
		}
	});
	const presenceLog = hs.changes?.logs.presence;
	const changedUsers = since !== null && presenceLog?.knowsAfter(since) ? presenceLog.filterChanged(sharingList, since) : null;
	const presenceQuery = !wantPresence ? {
		model: "presence",
		opts: { where: [{
			field: "user_id",
			operator: "in",
			value: []
		}] }
	} : since === null ? {
		model: "presence",
		opts: { where: [{
			field: "user_id",
			operator: "in",
			value: sharingList
		}] }
	} : changedUsers ? {
		model: "presence",
		opts: { where: [{
			field: "user_id",
			operator: "in",
			value: changedUsers
		}, {
			field: "stream",
			operator: "gt",
			value: since
		}] }
	} : recent("presence");
	let [presenceRows = [], newlySharedPresence = [], deviceRows] = await trackedReads(hs.db, hs.changes, [
		since === null ? { query: presenceQuery } : {
			query: presenceQuery,
			unlessChanged: {
				log: "presence",
				key: "*",
				after: since
			}
		},
		{ query: {
			model: "presence",
			opts: { where: [{
				field: "user_id",
				operator: "in",
				value: [...newlyShared]
			}] }
		} },
		...since !== null ? [{
			query: recent("device_list_changes"),
			unlessChanged: {
				log: "deviceLists",
				key: "*",
				after: since
			}
		}] : []
	]);
	if (since !== null) {
		if (presenceRows.length > RECENT_CHANGES) presenceRows = await hs.db.findMany("presence", { where: [{
			field: "user_id",
			operator: "in",
			value: sharingList
		}, {
			field: "stream",
			operator: "gt",
			value: since
		}] });
		else presenceRows = presenceRows.filter((r) => sharing.has(r.user_id));
		if (deviceRows.length > RECENT_CHANGES) deviceRows = await hs.db.findMany("device_list_changes", deviceListChangesQuery(sharing, since));
	}
	if (wantPresence) {
		const seen = /* @__PURE__ */ new Set();
		for (const row of [...presenceRows, ...newlySharedPresence]) {
			if (seen.has(row.user_id)) continue;
			seen.add(row.user_id);
			if (row.stream > p.to) continue;
			const content = {
				presence: row.presence,
				last_active_ago: Date.now() - row.last_active_ts,
				...row.status_msg ? { status_msg: row.status_msg } : {},
				...row.presence === "online" ? { currently_active: true } : {}
			};
			const ev = {
				type: M.PRESENCE,
				sender: row.user_id,
				content
			};
			if (matchesFilter(p.filter.presence, ev)) presenceEvents.push(ev);
		}
	}
	if (presenceEvents.length) empty = false;
	const profileUpdates = await profileUpdatesFor(hs, p, memberships, memberChanges);
	if (profileUpdates) empty = false;
	const body = {
		next_batch: formatToken({
			pos: p.to,
			toDevice: nextToDevice,
			ack: toDevice.length > 0
		}),
		rooms: Object.fromEntries(Object.entries({
			join,
			invite,
			leave,
			knock
		}).filter(([, v]) => Object.keys(v).length)),
		presence: { events: presenceEvents },
		account_data: { events: globalAccountData },
		to_device: { events: toDevice.map((r) => ({
			sender: r.sender,
			type: r.type,
			content: r.content
		})) },
		device_one_time_keys_count: countAlgorithms(oneTimeKeyRows),
		device_unused_fallback_key_types: [...new Set(fallbackRows.map((r) => r.algorithm))],
		...profileUpdates ? { [UNSTABLE.ORG.MATRIX.MSC4429.USERS]: profileUpdates } : {}
	};
	if (since !== null) {
		const lists = await hs.keys.changesSince(userId, since, p.to, {
			memberChanges: await memberChanges(),
			deviceRows,
			joinedRooms
		});
		body.device_lists = lists;
		if (lists.changed.length || lists.left.length) empty = false;
	}
	return {
		body,
		empty,
		nextToDevice
	};
}
const slots = /* @__PURE__ */ new WeakMap();
function syncSlots(hs) {
	let s = slots.get(hs);
	if (!s) slots.set(hs, s = new Semaphore(hs.config.maxConcurrentSyncs));
	return s;
}
async function sync(ctx) {
	const hs = ctx.hs;
	const session = await ctx.auth();
	const filter = await loadFilter(hs, session.userId, ctx.query.get("filter"));
	const since = parseSyncToken(ctx.query.get("since"));
	const fullState = ctx.query.get("full_state") === "true";
	const timeout = Math.min(Math.max(Number.parseInt(ctx.query.get("timeout") ?? "0", 10) || 0, 0), hs.config.maxSyncTimeoutMs);
	const setPresence = ctx.query.get("set_presence") ?? "online";
	if (setPresence !== "offline") await touchPresence(hs, session.userId, setPresence);
	const ignored = /* @__PURE__ */ new Set();
	const stable = ctx.query.get("use_state_after") === "true";
	const unstable = ctx.query.get(UNSTABLE.ORG.MATRIX.MSC4222.USE_STATE_AFTER) === "true";
	const useStateAfter = stable || unstable;
	const stateAfterKey = stable ? "state_after" : UNSTABLE.ORG.MATRIX.MSC4222.STATE_AFTER;
	const { value } = await longPoll(hs, session.userId, timeout, ctx.request.signal, async (to) => {
		const { body, empty } = await syncSlots(hs).run(() => buildSync(hs, {
			session,
			ignored,
			since,
			to,
			filter,
			fullState,
			useStateAfter,
			stateAfterKey
		}));
		return {
			value: body,
			done: !since || !empty || fullState
		};
	});
	return value;
}
const LAST_ACTIVE_GRANULARITY_MS = 6e4;
async function touchPresence(hs, userId, presence) {
	const state = presence === "unavailable" ? "unavailable" : "online";
	const read = () => hs.db.findOne("presence", [{
		field: "user_id",
		value: userId
	}]);
	const row = hs.changes ? await hs.changes.values.presenceRow.get(userId, read) : await read();
	if (row && row.presence === state) {
		if (Date.now() - row.last_active_ts >= LAST_ACTIVE_GRANULARITY_MS) await hs.db.update("presence", [{
			field: "user_id",
			value: userId
		}], { last_active_ts: Date.now() });
		return;
	}
	const stream = await hs.streams.write(async (stream) => {
		await hs.db.upsert("presence", {
			user_id: userId,
			presence: state,
			status_msg: row?.status_msg ?? null,
			last_active_ts: Date.now(),
			stream
		});
		return stream;
	});
	hs.notifier.notify([userId, ...await hs.rooms.usersSharingRooms(userId)], stream);
	await hs.federation.onPresence(userId, state, row?.status_msg ?? null).catch((err) => hs.logger.warn("Presence update to federation failed", err));
}
function registerSyncRoutes(r) {
	r.client("GET", "/sync", procedure({
		endpoint: "GET /v3/sync",
		handler: sync
	}));
	r.client("POST", "/user/:userId/filter", procedure({
		auth: "user",
		input: body({}),
		handler: async (ctx) => {
			const s = ctx.session;
			if (ctx.params.userId !== s.userId) throw errors.forbidden("Cannot create filters for other users");
			const filter = validateSyncFilter(ctx.input);
			const existing = await ctx.hs.db.findMany("filters", { where: [{
				field: "user_id",
				value: s.userId
			}] });
			const filterId = String(existing.reduce((max, f) => Math.max(max, Number(f.filter_id) || 0), 0) + 1);
			await ctx.hs.db.create("filters", {
				user_id: s.userId,
				filter_id: filterId,
				filter
			});
			return { filter_id: filterId };
		}
	}));
	r.client("GET", "/user/:userId/filter/:filterId", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			if (ctx.params.userId !== s.userId) throw errors.forbidden("Cannot read filters of other users");
			const row = await ctx.hs.db.findOne("filters", [{
				field: "user_id",
				value: s.userId
			}, {
				field: "filter_id",
				value: ctx.params.filterId
			}]);
			if (!row) throw errors.notFound("Unknown filter");
			return row.filter;
		}
	}));
}
/**
* MSC4429: profile changes of users sharing a room, limited to the fields the filter asks for.
* The initial sync carries current values; users we no longer share any room with get `null`.
*/
async function profileUpdatesFor(hs, p, memberships, memberChanges) {
	const ids = (p.filter.profile_fields ?? p.filter[UNSTABLE.ORG.MATRIX.MSC4429.PROFILE_FIELDS])?.ids;
	if (!Array.isArray(ids) || !ids.length) return null;
	const wanted = new Set(ids.filter((x) => typeof x === "string"));
	const since = p.since?.pos ?? null;
	const sharing = await hs.rooms.usersSharingRooms(p.session.userId);
	const out = {};
	const add = (userId, field, value) => {
		const updates = (out[userId] ??= { profile_updates: {} }).profile_updates;
		if (updates) updates[field] = value ?? null;
	};
	const full = new Set(since === null ? sharing : []);
	if (since !== null) {
		const myRooms = new Set(memberships.filter((m) => m.membership === "join").map((m) => m.room_id));
		const changes = await memberChanges();
		for (const c of changes) {
			if (c.stream > p.to || c.user_id === p.session.userId) continue;
			if (c.membership === "join" && myRooms.has(c.room_id)) {
				const ev = await hs.rooms.getEvent(c.event_id);
				if (!ev || previousMembership(ev.pdu) !== "join") full.add(c.user_id);
			} else if (!sharing.has(c.user_id) && (myRooms.has(c.room_id) || memberships.some((m) => m.room_id === c.room_id))) out[c.user_id] = { profile_updates: null };
		}
		const rows = await hs.db.findMany("profile_fields", { where: [{
			field: "stream",
			operator: "gt",
			value: since
		}] });
		for (const row of rows) {
			if (row.stream > p.to || !wanted.has(row.field) || !sharing.has(row.user_id) || full.has(row.user_id)) continue;
			add(row.user_id, row.field, row.value);
		}
	}
	for (const userId of full) {
		if (!sharing.has(userId) || !hs.isLocalUser(userId)) continue;
		const profile = await fullProfile(hs, userId) ?? {};
		for (const field of wanted) if (profile[field] !== void 0) add(userId, field, profile[field]);
	}
	return Object.keys(out).length ? out : null;
}
export { registerSyncRoutes, roomEphemeral, roomSummary, roomTimeline, toStripped };

//# sourceMappingURL=sync.js.map