import { isObject } from "../packages/shared/src/json.js";
import { M } from "../packages/shared/src/m.js";
import { errors } from "../core/errors.js";
import { getState } from "../core/authrules.js";
import { procedure } from "../http/procedure.js";
import { v } from "../core/vpm.js";
import { body, fail, lenient } from "../http/input.js";
import { assertEventFilter, matchesFilter } from "./filters.js";
import { paginate, topoToken } from "./timeline.js";
// src/api/search.ts
const DEFAULT_KEYS = [
	"content.body",
	"content.name",
	"content.topic"
];
function valueAt(obj, path) {
	return path.split(".").reduce((o, k) => isObject(o) ? o[k] : void 0, obj);
}
function registerSearchRoutes(r) {
	const missingTerm = fail("M_BAD_JSON", "Missing search_categories.room_events.search_term");
	const searchBody = body({ search_categories: v.looseObject({ room_events: v.looseObject({
		search_term: v.string(missingTerm),
		keys: lenient(v.array(v.string())),
		filter: v.unknown().optional(),
		order_by: v.unknown().optional(),
		event_context: lenient(v.object({
			before_limit: lenient(v.number()),
			after_limit: lenient(v.number()),
			include_profile: lenient(v.boolean())
		})),
		include_state: lenient(v.boolean()),
		groupings: lenient(v.object({ group_by: lenient(v.array(lenient(v.object({ key: lenient(v.string()) })))) }))
	}, missingTerm) }, missingTerm) });
	r.client("POST", "/search", procedure({
		auth: "user",
		input: searchBody,
		handler: async (ctx) => {
			const s = ctx.session;
			const hs = ctx.hs;
			const criteria = ctx.input.search_categories.room_events;
			const terms = criteria.search_term.toLowerCase().split(/\s+/).filter(Boolean);
			const keys = criteria.keys?.length ? criteria.keys : DEFAULT_KEYS;
			const raw = criteria.filter;
			if (raw !== void 0 && !isObject(raw)) throw errors.badJson("filter must be an object");
			assertEventFilter(raw, "filter");
			const filter = raw ?? {};
			const limit = Math.min(filter.limit ?? 10, 100);
			const orderBy = criteria.order_by === "recent" ? "recent" : "rank";
			const offset = Number.parseInt(ctx.query.get("next_batch") ?? "0", 10) || 0;
			let rooms = await hs.rooms.roomsForUser(s.userId);
			if (filter.rooms) rooms = rooms.filter((r) => filter.rooms.includes(r));
			if (filter.not_rooms) rooms = rooms.filter((r) => !filter.not_rooms.includes(r));
			const hits = [];
			for (const roomId of rooms) {
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
				const candidates = [];
				for (const row of rows) {
					if (row.state_key !== null || !matchesFilter(filter, row.json)) continue;
					let rank = 0;
					const words = [];
					for (const key of keys) {
						const v = valueAt(row.json, key);
						if (typeof v === "string") words.push(...v.toLowerCase().split(/[^\p{L}\p{N}]+/u));
					}
					if (terms.every((t) => words.includes(t))) for (const t of terms) rank += words.filter((w) => w === t).length;
					if (rank > 0) candidates.push({
						ev: hs.rooms.rowToStored(row),
						rank
					});
				}
				const visible = new Set((await hs.rooms.filterVisible(s.userId, roomId, candidates.map((c) => c.ev))).map((v) => v.pdu.event_id));
				hits.push(...candidates.filter((c) => visible.has(c.ev.pdu.event_id)));
			}
			hits.sort((a, b) => orderBy === "rank" && b.rank !== a.rank ? b.rank - a.rank : b.ev.stream - a.ev.stream);
			const page = hits.slice(offset, offset + limit);
			const viewer = {
				userId: s.userId,
				deviceId: s.deviceId
			};
			const results = [];
			for (const hit of page) results.push(await searchResult({
				hs,
				viewer,
				hit,
				context: criteria.event_context
			}));
			const state = {};
			if (criteria.include_state) for (const roomId of new Set(page.map((h) => h.ev.pdu.room_id))) state[roomId] = [...(await hs.rooms.currentState(roomId)).values()].map((e) => hs.rooms.formatEvent({
				pdu: e,
				stream: 0,
				snapshot: 0,
				txnId: null,
				txnToken: null
			}));
			const byRoom = criteria.groupings?.group_by?.some((g) => g?.key === "room_id");
			const groups = {};
			if (byRoom) hits.forEach((h, i) => (groups[h.ev.pdu.room_id] ??= {
				results: [],
				order: i,
				next_batch: null
			}).results.push(h.ev.pdu.event_id));
			const more = page.length === limit && offset + limit <= hits.length;
			return { search_categories: { room_events: {
				results,
				count: hits.length,
				highlights: terms,
				...more ? { next_batch: String(offset + limit) } : {},
				...criteria.include_state ? { state } : {},
				...byRoom ? { groups: { room_id: groups } } : {}
			} } };
		}
	}));
}
/** One search result: the event, and with `context` the events around it. */
async function searchResult(p) {
	const { hs, viewer, hit, context: ec } = p;
	const result = {
		rank: hit.rank,
		result: hs.rooms.formatEvent(hit.ev, viewer)
	};
	if (!ec) return result;
	const roomId = hit.ev.pdu.room_id;
	const here = {
		depth: hit.ev.pdu.depth,
		stream: hit.ev.stream
	};
	const before = await paginate(hs, viewer.userId, roomId, {
		from: here,
		to: null,
		dir: "b",
		limit: ec.before_limit ?? 5
	});
	const after = await paginate(hs, viewer.userId, roomId, {
		from: here,
		to: null,
		dir: "f",
		limit: ec.after_limit ?? 5
	});
	const context = {
		events_before: before.events.map((e) => hs.rooms.formatEvent(e, viewer)),
		events_after: after.events.map((e) => hs.rooms.formatEvent(e, viewer)),
		start: before.end ?? topoToken(before.events.at(-1) ?? hit.ev),
		end: topoToken(after.events.at(-1) ?? hit.ev)
	};
	if (!ec.include_profile) return {
		...result,
		context
	};
	return {
		...result,
		context: {
			...context,
			profile_info: await profiles(hs, roomId, [
				...before.events,
				hit.ev,
				...after.events
			])
		}
	};
}
/** The display name and avatar of each event's sender, from the room's current state. */
async function profiles(hs, roomId, events) {
	const state = await hs.rooms.currentState(roomId);
	const out = {};
	for (const e of events) {
		const m = getState(state, M.ROOM.MEMBER, e.pdu.sender)?.content;
		out[e.pdu.sender] = {
			displayname: m?.displayname,
			avatar_url: m?.avatar_url
		};
	}
	return out;
}
export { registerSearchRoutes };

//# sourceMappingURL=search.js.map