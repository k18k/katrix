import { isObject } from "../shared/json.js";
import { M } from "../shared/m.js";
import { toClientEvent } from "../core/events.js";
import { errors } from "../core/errors.js";
import { getState } from "../core/authrules.js";
import { procedure } from "../http/procedure.js";
import { matchesFilter, parseRoomEventFilter } from "./filters.js";
import { parseToken, requireRoom, viewerOf, visibleState } from "./rooms.js";
// src/api/timeline.ts
/** A gap event reached by backwards pagination (in the page, or anywhere older when the page ran out). */
async function findGapBefore(hs, roomId, events, end) {
	if (!hs.federation.enabled) return null;
	const inPage = events.find((e) => e.gap);
	if (inPage) return inPage;
	if (end !== null) return null;
	const rows = await hs.db.findMany("events", {
		where: [{
			field: "room_id",
			value: roomId
		}, {
			field: "gap",
			value: true
		}],
		limit: 1
	});
	return rows[0] ? hs.rooms.rowToStored(rows[0]) : null;
}
/** Backfill the history behind a gap event, then clear its gap flag. */
async function backfillGap(hs, roomId, gapEvent) {
	const fetched = await hs.federation.backfill(roomId, [gapEvent.pdu.event_id], 100);
	await hs.db.update("events", [{
		field: "event_id",
		value: gapEvent.pdu.event_id
	}], { gap: false });
	hs.rooms.forgetEventCache(gapEvent.pdu.event_id);
	return fetched > 0;
}
/** Backfill from other servers when our oldest event has unknown predecessors. Returns whether anything was fetched. */
async function backfillIfNeeded(hs, roomId) {
	if (!hs.federation.enabled) return false;
	const first = (await hs.db.findMany("events", {
		where: [{
			field: "room_id",
			value: roomId
		}],
		sortBy: {
			field: "stream",
			direction: "asc"
		},
		limit: 1
	}))[0];
	if (!first || first.type === M.ROOM.CREATE) return false;
	const prevs = (first.json.prev_events ?? []).map((p) => Array.isArray(p) ? p[0] : p);
	const known = await hs.rooms.getEvents(prevs);
	if (prevs.every((p) => known.has(p))) return false;
	return await hs.federation.backfill(roomId, [first.event_id], 50) > 0;
}
function parsePageToken(raw) {
	if (raw === null || raw === "") return null;
	const topo = /^t(-?\d+)_(-?\d+)$/.exec(raw);
	if (topo) return {
		depth: Number(topo[1]),
		stream: Number(topo[2])
	};
	const stream = /^s?(-?\d+)/.exec(raw);
	if (stream) return {
		depth: null,
		stream: Number(stream[1])
	};
	throw errors.invalidParam("Invalid pagination token");
}
const topoToken = (ev) => `t${ev.pdu.depth}_${ev.stream}`;
/** Topological comparison of (depth, stream) pairs. */
const cmp = (a, b) => a.depth - b.depth || a.stream - b.stream;
/**
* Fetch room events in topological order (as /messages requires), applying history
* visibility and filters, until `limit` events are found.
*/
async function paginate(hs, userId, roomId, opts) {
	const back = opts.dir === "b";
	const out = [];
	let cursor = opts.from && opts.from.depth !== null ? {
		depth: opts.from.depth,
		stream: opts.from.stream
	} : null;
	const streamBound = opts.from && opts.from.depth === null ? opts.from.stream : null;
	const batch = Math.max(opts.limit * 2, 50);
	const beyond = (pos) => {
		if (!opts.to) return false;
		if (opts.to.depth === null) return back ? pos.stream <= opts.to.stream : pos.stream > opts.to.stream;
		const c = cmp(pos, {
			depth: opts.to.depth,
			stream: opts.to.stream
		});
		return back ? c <= 0 : c > 0;
	};
	for (;;) {
		const where = [{
			field: "room_id",
			value: roomId
		}];
		if (cursor) where.push({
			field: "depth",
			operator: back ? "lte" : "gte",
			value: cursor.depth
		});
		if (streamBound !== null) where.push({
			field: "stream",
			operator: back ? "lte" : "gt",
			value: streamBound
		});
		let rows = await hs.db.findMany("events", {
			where,
			sortBy: {
				field: "depth",
				direction: back ? "desc" : "asc"
			},
			limit: batch
		});
		const full = rows.length === batch;
		if (full) {
			const edge = rows[rows.length - 1].depth;
			rows = rows.filter((r) => r.depth !== edge);
			rows.push(...await hs.db.findMany("events", { where: [...where, {
				field: "depth",
				value: edge
			}] }));
		}
		const stored = rows.map((r) => hs.rooms.rowToStored(r)).map((ev) => ({
			ev,
			pos: {
				depth: ev.pdu.depth,
				stream: ev.stream
			}
		})).filter(({ pos }) => !cursor || (back ? cmp(pos, cursor) < 0 : cmp(pos, cursor) > 0)).sort((a, b) => back ? cmp(b.pos, a.pos) : cmp(a.pos, b.pos));
		if (stored.length === 0) return {
			events: out,
			end: null
		};
		const visible = await hs.rooms.filterVisible(userId, roomId, stored.map((x) => x.ev));
		const visibleById = new Map(visible.map((v) => [v.pdu.event_id, v]));
		for (const { ev: raw, pos } of stored) {
			if (beyond(pos)) return {
				events: out,
				end: null
			};
			cursor = pos;
			const ev = visibleById.get(raw.pdu.event_id);
			if (!ev || !matchesFilter(opts.filter, ev.pdu)) continue;
			out.push(ev);
			if (out.length >= opts.limit) return {
				events: out,
				end: `t${pos.depth}_${pos.stream}`
			};
		}
		if (!full) return {
			events: out,
			end: null
		};
	}
}
async function relations(ctx) {
	const s = await ctx.auth();
	const hs = ctx.hs;
	const roomId = ctx.params.roomId;
	await visibleState(hs, roomId, s.userId);
	const parent = await hs.rooms.getEvent(ctx.params.eventId);
	if (!parent || parent.pdu.room_id !== roomId) throw errors.notFound("Event not found");
	const dir = ctx.query.get("dir") === "f" ? "f" : "b";
	const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "50", 10) || 50, 1), 1e3);
	const from = parseToken(ctx.query.get("from"));
	const rows = await hs.db.findMany("events", {
		where: [{
			field: "room_id",
			value: roomId
		}, ...from !== null ? [{
			field: "stream",
			operator: dir === "b" ? "lte" : "gt",
			value: from
		}] : []],
		sortBy: {
			field: "stream",
			direction: dir === "b" ? "desc" : "asc"
		}
	});
	const matches = [];
	let next = null;
	for (const row of rows) {
		const rel = row.json.content?.[M.RELATES_TO];
		if (!isObject(rel) || rel.event_id !== ctx.params.eventId) continue;
		if (ctx.params.relType && rel.rel_type !== ctx.params.relType) continue;
		if (ctx.params.eventType && row.type !== ctx.params.eventType) continue;
		const stored = hs.rooms.rowToStored(row);
		if ((await hs.rooms.filterVisible(s.userId, roomId, [stored])).length === 0) continue;
		if (matches.length >= limit) {
			next = dir === "b" ? matches[matches.length - 1].stream - 1 : matches[matches.length - 1].stream;
			break;
		}
		matches.push(stored);
	}
	const out = { chunk: matches.map((e) => hs.rooms.formatEvent(e, {
		userId: s.userId,
		deviceId: s.deviceId
	})) };
	if (next !== null) out.next_batch = `s${next}`;
	return out;
}
/** `GET /rooms/{roomId}/threads`: thread roots, most recently active first. */
async function threads(ctx) {
	const s = await ctx.auth();
	const hs = ctx.hs;
	const roomId = ctx.params.roomId;
	await visibleState(hs, roomId, s.userId);
	const include = ctx.query.get("include") === "participated" ? "participated" : "all";
	const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "50", 10) || 50, 1), 1e3);
	const from = parseToken(ctx.query.get("from"));
	const rows = await hs.db.findMany("events", {
		where: [{
			field: "room_id",
			value: roomId
		}],
		sortBy: {
			field: "stream",
			direction: "desc"
		}
	});
	const latest = /* @__PURE__ */ new Map();
	for (const row of rows) {
		const rel = row.json.content?.[M.RELATES_TO];
		if (!isObject(rel) || rel.rel_type !== M.THREAD || typeof rel.event_id !== "string") continue;
		const entry = latest.get(rel.event_id) ?? {
			stream: row.stream,
			latestId: row.event_id,
			count: 0,
			participants: /* @__PURE__ */ new Set()
		};
		entry.participants.add(row.sender);
		entry.count++;
		latest.set(rel.event_id, entry);
	}
	const roots = [];
	for (const [rootId, info] of latest) {
		const root = await hs.rooms.getEvent(rootId);
		if (!root || root.pdu.room_id !== roomId) continue;
		if (include === "participated" && root.pdu.sender !== s.userId && !info.participants.has(s.userId)) continue;
		if ((await hs.rooms.filterVisible(s.userId, roomId, [root])).length === 0) continue;
		roots.push({
			ev: root,
			stream: info.stream
		});
	}
	roots.sort((a, b) => b.stream - a.stream);
	const page = roots.filter((r) => from === null || r.stream <= from);
	const chunk = page.slice(0, limit);
	const viewer = {
		userId: s.userId,
		deviceId: s.deviceId
	};
	const out = { chunk: await Promise.all(chunk.map(async (r) => {
		const ev = hs.rooms.formatEvent(r.ev, viewer);
		const info = latest.get(r.ev.pdu.event_id);
		const latestEv = await hs.rooms.getEvent(info.latestId);
		ev.unsigned = {
			...ev.unsigned,
			[M.RELATIONS]: {
				...ev.unsigned?.[M.RELATIONS],
				[M.THREAD]: {
					latest_event: latestEv ? hs.rooms.formatEvent(latestEv, viewer) : void 0,
					count: info.count,
					current_user_participated: r.ev.pdu.sender === s.userId || info.participants.has(s.userId)
				}
			}
		};
		return ev;
	})) };
	if (page.length > limit) out.next_batch = `s${page[limit].stream}`;
	return out;
}
/**
* A room's events ordered by timestamp in the search direction of `timestamp_to_event` (equal timestamps: the
* topologically nearest first). Arrival order (stream) is not timestamp order for federated events (#105).
* shortcut: reads all of the room's events; an indexed origin_server_ts column would bound it, once old rows get one.
*/
async function eventsByTimestamp(hs, roomId, dir) {
	return (await hs.db.findMany("events", { where: [{
		field: "room_id",
		value: roomId
	}] })).sort((a, b) => dir === "f" ? a.json.origin_server_ts - b.json.origin_server_ts || a.depth - b.depth || a.stream - b.stream : b.json.origin_server_ts - a.json.origin_server_ts || b.depth - a.depth || b.stream - a.stream);
}
function registerTimelineRoutes(r) {
	r.client("GET", "/rooms/:roomId/messages", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const hs = ctx.hs;
			const roomId = ctx.params.roomId;
			await visibleState(hs, roomId, s.userId);
			const dir = ctx.query.get("dir") ?? "b";
			if (dir !== "b" && dir !== "f") throw errors.invalidParam("dir must be 'b' or 'f'");
			const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "10", 10) || 10, 1), 1e3);
			const filter = parseRoomEventFilter(ctx);
			const fromRaw = ctx.query.get("from");
			const from = parsePageToken(fromRaw) ?? (dir === "b" ? {
				depth: null,
				stream: await hs.streams.position()
			} : null);
			const to = parsePageToken(ctx.query.get("to"));
			let { events, end } = await paginate(hs, s.userId, roomId, {
				from,
				to,
				dir,
				limit: filter?.limit ?? limit,
				filter
			});
			for (let attempt = 0; attempt < 3 && dir === "b"; attempt++) {
				const gapEvent = await findGapBefore(hs, roomId, events, end);
				if (!(gapEvent ? await backfillGap(hs, roomId, gapEvent) : end === null && events.length < (filter?.limit ?? limit) && await backfillIfNeeded(hs, roomId))) break;
				({events, end} = await paginate(hs, s.userId, roomId, {
					from,
					to,
					dir,
					limit: filter?.limit ?? limit,
					filter
				}));
			}
			const out = {
				chunk: events.map((e) => hs.rooms.formatEvent(e, viewerOf(s))),
				start: fromRaw ?? (from ? from.depth === null ? `s${from.stream}` : `t${from.depth}_${from.stream}` : "t0_0")
			};
			if (end !== null) out.end = end;
			else if (events.length) out.end = topoToken(events[events.length - 1]);
			if (filter?.lazy_load_members) {
				const current = await hs.rooms.currentState(roomId);
				out.state = [...new Set(events.map((e) => e.pdu.sender))].map((u) => getState(current, M.ROOM.MEMBER, u)).filter(Boolean).map((e) => toClientEvent(e));
			}
			return out;
		}
	}));
	r.client("GET", "/rooms/:roomId/event/:eventId", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const hs = ctx.hs;
			await requireRoom(hs, ctx.params.roomId);
			const ev = await hs.rooms.getEvent(ctx.params.eventId);
			if (!ev || ev.pdu.room_id !== ctx.params.roomId) throw errors.notFound("Event not found");
			if ((await hs.rooms.filterVisible(s.userId, ctx.params.roomId, [ev])).length === 0) throw errors.notFound("Event not found");
			return hs.rooms.formatEvent(ev, viewerOf(s));
		}
	}));
	r.client("GET", "/rooms/:roomId/context/:eventId", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const hs = ctx.hs;
			const roomId = ctx.params.roomId;
			await requireRoom(hs, roomId);
			const ev = await hs.rooms.getEvent(ctx.params.eventId);
			if (!ev || ev.pdu.room_id !== roomId || (await hs.rooms.filterVisible(s.userId, roomId, [ev])).length === 0) throw errors.notFound("Event not found");
			const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "10", 10) || 10, 0), 100);
			const filter = parseRoomEventFilter(ctx);
			const here = {
				depth: ev.pdu.depth,
				stream: ev.stream
			};
			const before = await paginate(hs, s.userId, roomId, {
				from: here,
				to: null,
				dir: "b",
				limit: Math.floor(limit / 2) || (limit ? 1 : 0),
				filter
			});
			const after = await paginate(hs, s.userId, roomId, {
				from: here,
				to: null,
				dir: "f",
				limit: Math.ceil(limit / 2),
				filter
			});
			const beforeEvents = limit ? before.events : [];
			const afterEvents = limit ? after.events : [];
			const state = await hs.rooms.stateAtSnapshot(ev.snapshot);
			return {
				event: hs.rooms.formatEvent(ev, viewerOf(s)),
				events_before: beforeEvents.map((e) => hs.rooms.formatEvent(e, viewerOf(s))),
				events_after: afterEvents.map((e) => hs.rooms.formatEvent(e, viewerOf(s))),
				start: topoToken(beforeEvents.length ? beforeEvents[beforeEvents.length - 1] : ev),
				end: topoToken(afterEvents.length ? afterEvents[afterEvents.length - 1] : ev),
				state: [...state.values()].map((e) => toClientEvent(e))
			};
		}
	}));
	const relVersions = ["v1", "v3"];
	r.client("GET", "/rooms/:roomId/relations/:eventId", procedure({ handler: relations }), relVersions);
	r.client("GET", "/rooms/:roomId/relations/:eventId/:relType", procedure({ handler: relations }), relVersions);
	r.client("GET", "/rooms/:roomId/relations/:eventId/:relType/:eventType", procedure({ handler: relations }), relVersions);
	r.client("GET", "/rooms/:roomId/threads", procedure({ handler: threads }), ["v1"]);
	r.client("GET", "/rooms/:roomId/timestamp_to_event", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const hs = ctx.hs;
			const roomId = ctx.params.roomId;
			await visibleState(hs, roomId, s.userId);
			const ts = Number(ctx.query.get("ts"));
			const dir = ctx.query.get("dir");
			if (!Number.isFinite(ts) || dir !== "f" && dir !== "b") throw errors.invalidParam("Invalid ts or dir");
			let local = null;
			for (const row of await eventsByTimestamp(hs, roomId, dir)) {
				const t = row.json.origin_server_ts;
				if (!(dir === "f" ? t >= ts : t <= ts)) continue;
				if ((await hs.rooms.filterVisible(s.userId, roomId, [hs.rooms.rowToStored(row)])).length) {
					local = {
						event_id: row.event_id,
						origin_server_ts: t
					};
					break;
				}
			}
			if (hs.federation.enabled) for (const server of hs.federation.serversInRoom(await hs.rooms.currentState(roomId))) try {
				const remote = await hs.federation.client.request(server, "GET", `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(roomId)}`, {
					query: {
						ts: String(ts),
						dir
					},
					timeoutMs: 1e4
				});
				if (typeof remote.event_id !== "string" || typeof remote.origin_server_ts !== "number") continue;
				if (!local || (dir === "f" ? remote.origin_server_ts < local.origin_server_ts : remote.origin_server_ts > local.origin_server_ts)) {
					if (!await hs.rooms.getEvent(remote.event_id)) await hs.federation.backfill(roomId, [remote.event_id], 1).catch(() => 0);
					local = {
						event_id: remote.event_id,
						origin_server_ts: remote.origin_server_ts
					};
				}
				break;
			} catch {}
			if (!local) throw errors.notFound("No event found");
			return local;
		}
	}), ["v1", "v3"]);
}
export { eventsByTimestamp, paginate, parsePageToken, registerTimelineRoutes, topoToken };

//# sourceMappingURL=timeline.js.map