import { M } from "../shared/m.js";
import { splitStateKey, stripState } from "../core/events.js";
import { errors } from "../core/errors.js";
import { getState, membershipOf } from "../core/authrules.js";
import { procedure } from "../http/procedure.js";
// src/api/spaces.ts
/** Room-level details shared by /hierarchy, /room_summary and /publicRooms. */
async function roomDetails(hs, roomId) {
	const state = await hs.rooms.currentState(roomId);
	const get = (t) => getState(state, t)?.content;
	const out = {
		room_id: roomId,
		num_joined_members: (await hs.rooms.joinedMembers(roomId)).length,
		world_readable: get(M.ROOM.HISTORY_VISIBILITY)?.history_visibility === "world_readable",
		guest_can_join: get(M.ROOM.GUEST_ACCESS)?.guest_access === "can_join",
		join_rule: get(M.ROOM.JOIN_RULES)?.join_rule ?? "invite"
	};
	const str = (v) => typeof v === "string" ? v : void 0;
	if (str(get(M.ROOM.NAME)?.name)) out.name = get(M.ROOM.NAME).name;
	if (str(get(M.ROOM.TOPIC)?.topic)) out.topic = get(M.ROOM.TOPIC).topic;
	if (str(get(M.ROOM.CANONICAL_ALIAS)?.alias)) out.canonical_alias = get(M.ROOM.CANONICAL_ALIAS).alias;
	if (str(get(M.ROOM.AVATAR)?.url)) out.avatar_url = get(M.ROOM.AVATAR).url;
	if (str(get(M.ROOM.CREATE)?.type)) out.room_type = get(M.ROOM.CREATE).type;
	return out;
}
/** Whether a user may see a room's summary (spec: "accessible" rooms). */
async function canAccess(hs, roomId, userId) {
	const state = await hs.rooms.currentState(roomId);
	if (userId && [
		"join",
		"invite",
		"knock"
	].includes(membershipOf(state, userId))) return true;
	if (getState(state, M.ROOM.HISTORY_VISIBILITY)?.content?.history_visibility === "world_readable") return true;
	const joinRules = getState(state, M.ROOM.JOIN_RULES)?.content;
	const rule = joinRules?.join_rule ?? "invite";
	if (rule === "public" || rule === "knock") return true;
	if ((rule === "restricted" || rule === "knock_restricted") && userId) {
		if (rule === "knock_restricted") return true;
		for (const allow of Array.isArray(joinRules?.allow) ? joinRules.allow : []) if (allow?.type === M.ROOM_MEMBERSHIP && typeof allow.room_id === "string" && await hs.rooms.exists(allow.room_id)) {
			if (await hs.rooms.membership(allow.room_id, userId) === "join") return true;
		}
	}
	return false;
}
function allowedRoomIds(joinRules) {
	if (!joinRules || !["restricted", "knock_restricted"].includes(joinRules.join_rule)) return void 0;
	return (Array.isArray(joinRules.allow) ? joinRules.allow : []).filter((a) => a?.type === M.ROOM_MEMBERSHIP && typeof a.room_id === "string").map((a) => a.room_id);
}
/** Spec ordering of space children: valid `order` strings first, then child event timestamp, then room ID. */
function childOrder(a, b) {
	const valid = (o) => typeof o === "string" && o.length <= 50 && /^[\x20-\x7E]*$/.test(o) ? o : null;
	const oa = valid(a.content?.order);
	const ob = valid(b.content?.order);
	if (oa !== null && ob === null) return -1;
	if (oa === null && ob !== null) return 1;
	if (oa !== null && ob !== null && oa !== ob) return oa < ob ? -1 : 1;
	return (a.origin_server_ts ?? 0) - (b.origin_server_ts ?? 0) || (a.state_key < b.state_key ? -1 : a.state_key > b.state_key ? 1 : 0);
}
/** Fetch a room's summary from another server via federation /hierarchy, if the user may see it. */
async function remoteSummary(hs, roomId, via, suggestedOnly, userId) {
	if (!hs.federation.enabled) return null;
	for (const server of via.filter((v) => v !== hs.serverName)) try {
		const room = (await hs.federation.queryHierarchy(server, roomId, suggestedOnly)).room;
		if (!room || room.room_id !== roomId) continue;
		const rule = room.join_rule ?? "invite";
		let accessible = room.world_readable === true || [
			"public",
			"knock",
			"knock_restricted"
		].includes(rule);
		if (!accessible && rule === "restricted" && Array.isArray(room.allowed_room_ids)) {
			for (const allowed of room.allowed_room_ids) if (await hs.rooms.exists(allowed) && await hs.rooms.membership(allowed, userId) === "join") {
				accessible = true;
				break;
			}
		}
		return accessible ? room : null;
	} catch {}
	return null;
}
function registerSpaceRoutes(r) {
	r.client("GET", "/rooms/:roomId/hierarchy", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const hs = ctx.hs;
			const rootId = ctx.params.roomId;
			if (!await hs.rooms.exists(rootId) || !await canAccess(hs, rootId, s.userId)) throw errors.forbidden("You cannot view this room");
			const suggestedOnly = ctx.query.get("suggested_only") === "true";
			const maxDepth = ctx.query.has("max_depth") ? Number.parseInt(ctx.query.get("max_depth"), 10) : Infinity;
			const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "50", 10) || 50, 1), 100);
			const from = ctx.query.get("from");
			let offset = 0;
			if (from) {
				const m = /^(\d+)_(.+)$/.exec(from);
				if (!m || m[2] !== `${rootId}|${suggestedOnly}|${ctx.query.get("max_depth") ?? ""}`) throw errors.invalidParam("Invalid pagination token");
				offset = Number(m[1]);
			}
			const rooms = [];
			const seen = /* @__PURE__ */ new Set();
			const queue = [{
				roomId: rootId,
				depth: 0,
				via: []
			}];
			while (queue.length) {
				const { roomId, depth, via } = queue.pop();
				if (seen.has(roomId)) continue;
				seen.add(roomId);
				if (!await hs.rooms.serverIsJoined(roomId)) {
					const remote = await remoteSummary(hs, roomId, via, suggestedOnly, s.userId);
					if (!remote) continue;
					rooms.push(remote);
					const remoteChildren = (remote.room_type === M.SPACE._ ? remote.children_state ?? [] : []).filter((c) => Array.isArray(c.content?.via) && c.content.via.length).sort(childOrder);
					if (depth < maxDepth) for (const child of [...remoteChildren].reverse()) queue.push({
						roomId: child.state_key,
						depth: depth + 1,
						via: child.content.via
					});
					continue;
				}
				if (roomId !== rootId && !await canAccess(hs, roomId, s.userId)) continue;
				const state = await hs.rooms.currentState(roomId);
				const children = [];
				const isSpace = getState(state, M.ROOM.CREATE)?.content?.type === M.SPACE._;
				for (const [key, ev] of isSpace ? state : []) {
					const [type] = splitStateKey(key);
					if (type !== M.SPACE.CHILD || !Array.isArray(ev.content?.via) || ev.content.via.length === 0) continue;
					if (suggestedOnly && ev.content.suggested !== true) continue;
					children.push({
						...stripState(ev),
						origin_server_ts: ev.origin_server_ts
					});
				}
				children.sort(childOrder);
				if (depth < maxDepth) for (const child of [...children].reverse()) queue.push({
					roomId: child.state_key,
					depth: depth + 1,
					via: child.content.via
				});
				const details = await roomDetails(hs, roomId);
				const allowed = allowedRoomIds(getState(state, M.ROOM.JOIN_RULES)?.content);
				if (allowed) details.allowed_room_ids = allowed;
				details.children_state = children;
				rooms.push(details);
			}
			const out = { rooms: rooms.slice(offset, offset + limit) };
			if (offset + limit < rooms.length) out.next_batch = `${offset + limit}_${rootId}|${suggestedOnly}|${ctx.query.get("max_depth") ?? ""}`;
			return out;
		}
	}), ["v1"]);
	const summary = async (ctx) => {
		const s = await ctx.optionalAuth();
		const hs = ctx.hs;
		let roomId;
		try {
			roomId = await hs.rooms.resolveRoomIdOrAlias(ctx.params.roomIdOrAlias);
		} catch {
			throw errors.notFound("Room not found");
		}
		if (!await hs.rooms.exists(roomId) || !await canAccess(hs, roomId, s?.userId ?? null)) throw errors.notFound("Room not found");
		const state = await hs.rooms.currentState(roomId);
		const out = await roomDetails(hs, roomId);
		out.room_version = await hs.rooms.roomVersion(roomId);
		const enc = getState(state, M.ROOM.ENCRYPTION)?.content?.algorithm;
		if (typeof enc === "string") out.encryption = enc;
		if (s) out.membership = membershipOf(state, s.userId);
		const allowed = allowedRoomIds(getState(state, M.ROOM.JOIN_RULES)?.content);
		if (allowed) out.allowed_room_ids = allowed;
		return out;
	};
	r.client("GET", "/room_summary/:roomIdOrAlias", procedure({ handler: summary }), ["v1"]);
	r.get("/_matrix/client/unstable/im.nheko.summary/summary/:roomIdOrAlias", procedure({ handler: summary }));
}
export { registerSpaceRoutes, roomDetails };

//# sourceMappingURL=spaces.js.map