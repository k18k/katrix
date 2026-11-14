import { isObject, isStrings, stringOrUndefined } from "../packages/shared/src/json.js";
import { M } from "../packages/shared/src/m.js";
import { errors } from "../core/errors.js";
import { getState, membershipOf } from "../core/authrules.js";
import { stripState } from "../core/events.js";
import { procedure } from "../http/procedure.js";
// src/api/spaces.ts
/** Room-level details shared by /hierarchy, /room_summary and /publicRooms. */
async function roomDetails(hs, roomId) {
	const state = await hs.rooms.currentState(roomId);
	const get = (t) => getState(state, t)?.content;
	const text = (value) => stringOrUndefined(value) || void 0;
	return {
		room_id: roomId,
		num_joined_members: (await hs.rooms.joinedMembers(roomId)).length,
		world_readable: get(M.ROOM.HISTORY_VISIBILITY)?.history_visibility === "world_readable",
		guest_can_join: get(M.ROOM.GUEST_ACCESS)?.guest_access === "can_join",
		join_rule: stringOrUndefined(get(M.ROOM.JOIN_RULES)?.join_rule) ?? "invite",
		name: text(get(M.ROOM.NAME)?.name),
		topic: text(get(M.ROOM.TOPIC)?.topic),
		canonical_alias: text(get(M.ROOM.CANONICAL_ALIAS)?.alias),
		avatar_url: text(get(M.ROOM.AVATAR)?.url),
		room_type: text(get(M.ROOM.CREATE)?.type)
	};
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
	if (!userId) return false;
	if (rule === "knock_restricted") return true;
	for (const allowed of allowedRoomIds(joinRules) ?? []) if (await hs.rooms.exists(allowed) && await hs.rooms.membership(allowed, userId) === "join") return true;
	return false;
}
/** The rooms whose members may join a restricted room; undefined for a room that is not restricted. */
function allowedRoomIds(joinRules) {
	if (joinRules?.join_rule !== "restricted" && joinRules?.join_rule !== "knock_restricted") return void 0;
	return (Array.isArray(joinRules.allow) ? joinRules.allow : []).flatMap((a) => isObject(a) && a.type === M.ROOM_MEMBERSHIP && typeof a.room_id === "string" ? [a.room_id] : []);
}
const MAX_ORDER_LENGTH = 50;
/** An m.space.child event of /hierarchy with what the walk needs from it; nothing when it does not name servers. */
function spaceChild(event) {
	if (!isObject(event) || typeof event.state_key !== "string" || !isObject(event.content)) return [];
	const { via, order } = event.content;
	if (!isStrings(via) || via.length === 0) return [];
	const validOrder = typeof order === "string" && order.length <= MAX_ORDER_LENGTH && /^[\x20-\x7E]*$/.test(order);
	const ts = typeof event.origin_server_ts === "number" ? event.origin_server_ts : 0;
	return [{
		event,
		roomId: event.state_key,
		via,
		order: validOrder ? order : null,
		ts
	}];
}
/** Spec ordering of space children: valid `order` strings first, then child event timestamp, then room ID. */
function childOrder(a, b) {
	if (a.order !== null && b.order === null) return -1;
	if (a.order === null && b.order !== null) return 1;
	if (a.order !== null && b.order !== null && a.order !== b.order) return a.order < b.order ? -1 : 1;
	return a.ts - b.ts || (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0);
}
/** Fetch a room's summary from another server via federation /hierarchy, if the user may see it. */
async function remoteSummary(hs, roomId, via, suggestedOnly, userId) {
	if (!hs.federation.enabled) return null;
	for (const server of via.filter((v) => v !== hs.serverName)) try {
		const room = (await hs.federation.queryHierarchy(server, roomId, suggestedOnly)).room;
		if (!isObject(room) || room.room_id !== roomId) continue;
		const rule = stringOrUndefined(room.join_rule) ?? "invite";
		let accessible = room.world_readable === true || [
			"public",
			"knock",
			"knock_restricted"
		].includes(rule);
		if (!accessible && rule === "restricted" && isStrings(room.allowed_room_ids)) {
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
					const remoteChildren = (remote.room_type === M.SPACE._ && Array.isArray(remote.children_state) ? remote.children_state : []).flatMap(spaceChild).sort(childOrder);
					if (depth < maxDepth) for (const child of remoteChildren.reverse()) queue.push({
						roomId: child.roomId,
						depth: depth + 1,
						via: child.via
					});
					continue;
				}
				if (roomId !== rootId && !await canAccess(hs, roomId, s.userId)) continue;
				const state = await hs.rooms.currentState(roomId);
				const children = [...getState(state, M.ROOM.CREATE)?.content?.type === M.SPACE._ ? state.values() : []].filter((ev) => ev.type === M.SPACE.CHILD && (!suggestedOnly || ev.content.suggested === true)).flatMap((ev) => spaceChild({
					...stripState(ev),
					origin_server_ts: ev.origin_server_ts
				})).sort(childOrder);
				if (depth < maxDepth) for (const child of [...children].reverse()) queue.push({
					roomId: child.roomId,
					depth: depth + 1,
					via: child.via
				});
				const allowed = allowedRoomIds(getState(state, M.ROOM.JOIN_RULES)?.content);
				rooms.push({
					...await roomDetails(hs, roomId),
					...allowed ? { allowed_room_ids: allowed } : {},
					children_state: children.map((child) => child.event)
				});
			}
			const page = rooms.slice(offset, offset + limit);
			if (offset + limit >= rooms.length) return { rooms: page };
			return {
				rooms: page,
				next_batch: `${offset + limit}_${rootId}|${suggestedOnly}|${ctx.query.get("max_depth") ?? ""}`
			};
		}
	}), ["v1"]);
	const summary = async (ctx) => {
		const s = await ctx.optionalAuth();
		const hs = ctx.hs;
		let roomId;
		try {
			roomId = await hs.membership.resolveRoomIdOrAlias(ctx.params.roomIdOrAlias);
		} catch {
			throw errors.notFound("Room not found");
		}
		if (!await hs.rooms.exists(roomId) || !await canAccess(hs, roomId, s?.userId ?? null)) throw errors.notFound("Room not found");
		const state = await hs.rooms.currentState(roomId);
		const encryption = stringOrUndefined(getState(state, M.ROOM.ENCRYPTION)?.content?.algorithm);
		const allowed = allowedRoomIds(getState(state, M.ROOM.JOIN_RULES)?.content);
		return {
			...await roomDetails(hs, roomId),
			room_version: await hs.rooms.roomVersion(roomId),
			...encryption === void 0 ? {} : { encryption },
			...s ? { membership: membershipOf(state, s.userId) } : {},
			...allowed ? { allowed_room_ids: allowed } : {}
		};
	};
	r.client("GET", "/room_summary/:roomIdOrAlias", procedure({ handler: summary }), ["v1"]);
	r.get("/_matrix/client/unstable/im.nheko.summary/summary/:roomIdOrAlias", procedure({ handler: summary }));
}
export { allowedRoomIds, registerSpaceRoutes, roomDetails };

//# sourceMappingURL=spaces.js.map