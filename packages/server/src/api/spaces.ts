import { isObject, isStrings, M, stringOrUndefined } from "@katrix/shared";
import { errors } from "#core/errors.ts";
import { getState, membershipOf } from "#core/authrules.ts";
import { stripState } from "#core/events.ts";
import type { Homeserver } from "#homeserver.ts";
import type { RequestContext, Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";

// https://github.com/k18k/katrix/issues/128: the details, summaries and hierarchy rooms were Record<string, any> that each
// caller added fields to, and the children a remote server listed were read unchecked. The
// shapes are built in one piece now, and a child is taken only when it has the fields used here.

/** Room-level details shared by /hierarchy, /room_summary and /publicRooms. */
export async function roomDetails(hs: Homeserver, roomId: string) {
  const state = await hs.rooms.currentState(roomId);
  const get = (t: string) => getState(state, t)?.content;
  // Left out when it is not a string or empty.
  const text = (value: unknown) => stringOrUndefined(value) || undefined;
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
    room_type: text(get(M.ROOM.CREATE)?.type),
  };
}

/** Whether a user may see a room's summary (spec: "accessible" rooms). */
async function canAccess(hs: Homeserver, roomId: string, userId: string | null): Promise<boolean> {
  const state = await hs.rooms.currentState(roomId);
  if (userId && ["join", "invite", "knock"].includes(membershipOf(state, userId))) return true;
  if (getState(state, M.ROOM.HISTORY_VISIBILITY)?.content?.history_visibility === "world_readable") return true;
  const joinRules = getState(state, M.ROOM.JOIN_RULES)?.content;
  const rule = joinRules?.join_rule ?? "invite";
  if (rule === "public" || rule === "knock") return true;
  if (!userId) return false;
  if (rule === "knock_restricted") return true;
  for (const allowed of allowedRoomIds(joinRules) ?? []) {
    if ((await hs.rooms.exists(allowed)) && (await hs.rooms.membership(allowed, userId)) === "join") return true;
  }
  return false;
}

/** The rooms whose members may join a restricted room; undefined for a room that is not restricted. */
export function allowedRoomIds(joinRules: Record<string, unknown> | undefined) {
  if (joinRules?.join_rule !== "restricted" && joinRules?.join_rule !== "knock_restricted") return undefined;
  const allow: unknown[] = Array.isArray(joinRules.allow) ? joinRules.allow : [];
  return allow.flatMap((a) => (isObject(a) && a.type === M.ROOM_MEMBERSHIP && typeof a.room_id === "string" ? [a.room_id] : []));
}

const MAX_ORDER_LENGTH = 50;

/** An m.space.child event of /hierarchy with what the walk needs from it; nothing when it does not name servers. */
function spaceChild(event: unknown) {
  if (!isObject(event) || typeof event.state_key !== "string" || !isObject(event.content)) return [];
  const { via, order } = event.content;
  if (!isStrings(via) || via.length === 0) return [];
  const validOrder = typeof order === "string" && order.length <= MAX_ORDER_LENGTH && /^[\x20-\x7E]*$/.test(order);
  const ts = typeof event.origin_server_ts === "number" ? event.origin_server_ts : 0;
  return [{ event, roomId: event.state_key, via, order: validOrder ? order : null, ts }];
}

/** Spec ordering of space children: valid `order` strings first, then child event timestamp, then room ID. */
function childOrder(a: { order: string | null; ts: number; roomId: string }, b: typeof a) {
  if (a.order !== null && b.order === null) return -1;
  if (a.order === null && b.order !== null) return 1;
  if (a.order !== null && b.order !== null && a.order !== b.order) return a.order < b.order ? -1 : 1;
  return a.ts - b.ts || (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0);
}

/** Fetch a room's summary from another server via federation /hierarchy, if the user may see it. */
async function remoteSummary(hs: Homeserver, roomId: string, via: string[], suggestedOnly: boolean, userId: string) {
  if (!hs.federation.enabled) return null;
  for (const server of via.filter((v) => v !== hs.serverName)) {
    try {
      const res = await hs.federation.queryHierarchy(server, roomId, suggestedOnly);
      const room = res.room;
      if (!isObject(room) || room.room_id !== roomId) continue;
      const rule = stringOrUndefined(room.join_rule) ?? "invite";
      let accessible = room.world_readable === true || ["public", "knock", "knock_restricted"].includes(rule);
      if (!accessible && rule === "restricted" && isStrings(room.allowed_room_ids)) {
        for (const allowed of room.allowed_room_ids) {
          if ((await hs.rooms.exists(allowed)) && (await hs.rooms.membership(allowed, userId)) === "join") {
            accessible = true;
            break;
          }
        }
      }
      return accessible ? room : null;
    } catch {
      /* try the next server */
    }
  }
  return null;
}

export function registerSpaceRoutes(r: Router): void {
  r.client(
    "GET",
    "/rooms/:roomId/hierarchy",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const hs = ctx.hs;
        const rootId = ctx.params.roomId;
        if (!(await hs.rooms.exists(rootId)) || !(await canAccess(hs, rootId, s.userId)))
          throw errors.forbidden("You cannot view this room");
        const suggestedOnly = ctx.query.get("suggested_only") === "true";
        const maxDepth = ctx.query.has("max_depth") ? Number.parseInt(ctx.query.get("max_depth")!, 10) : Infinity;
        const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "50", 10) || 50, 1), 100);
        const from = ctx.query.get("from");
        let offset = 0;
        if (from) {
          const m = /^(\d+)_(.+)$/.exec(from);
          // Tokens are bound to the query parameters they were issued for.
          if (!m || m[2] !== `${rootId}|${suggestedOnly}|${ctx.query.get("max_depth") ?? ""}`)
            throw errors.invalidParam("Invalid pagination token");
          offset = Number(m[1]);
        }

        const rooms: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        // Depth-first traversal (a stack), like Synapse, so pages follow the space tree.
        const queue: { roomId: string; depth: number; via: string[] }[] = [{ roomId: rootId, depth: 0, via: [] }];
        while (queue.length) {
          const { roomId, depth, via } = queue.pop()!;
          if (seen.has(roomId)) continue;
          seen.add(roomId);
          if (!(await hs.rooms.serverIsJoined(roomId))) {
            // A room hosted elsewhere: ask a server from the space's `via` list.
            const remote = await remoteSummary(hs, roomId, via, suggestedOnly, s.userId);
            if (!remote) continue;
            rooms.push(remote);
            const listed: unknown[] = remote.room_type === M.SPACE._ && Array.isArray(remote.children_state) ? remote.children_state : [];
            const remoteChildren = listed.flatMap(spaceChild).sort(childOrder);
            if (depth < maxDepth) {
              for (const child of remoteChildren.reverse()) queue.push({ roomId: child.roomId, depth: depth + 1, via: child.via });
            }
            continue;
          }
          if (roomId !== rootId && !(await canAccess(hs, roomId, s.userId))) continue;
          const state = await hs.rooms.currentState(roomId);
          // Only spaces have children; m.space.child events in ordinary rooms are ignored.
          const isSpace = getState(state, M.ROOM.CREATE)?.content?.type === M.SPACE._;
          const children = [...(isSpace ? state.values() : [])]
            .filter((ev) => ev.type === M.SPACE.CHILD && (!suggestedOnly || ev.content.suggested === true))
            .flatMap((ev) => spaceChild({ ...stripState(ev), origin_server_ts: ev.origin_server_ts }))
            .sort(childOrder);
          if (depth < maxDepth) {
            // Pushed in reverse so that the first child is visited next.
            for (const child of [...children].reverse()) queue.push({ roomId: child.roomId, depth: depth + 1, via: child.via });
          }
          const allowed = allowedRoomIds(getState(state, M.ROOM.JOIN_RULES)?.content);
          rooms.push({
            ...(await roomDetails(hs, roomId)),
            ...(allowed ? { allowed_room_ids: allowed } : {}),
            children_state: children.map((child) => child.event),
          });
        }
        const page = rooms.slice(offset, offset + limit);
        if (offset + limit >= rooms.length) return { rooms: page };
        return { rooms: page, next_batch: `${offset + limit}_${rootId}|${suggestedOnly}|${ctx.query.get("max_depth") ?? ""}` };
      },
    }),
    ["v1"],
  );

  const summary = async (ctx: RequestContext) => {
    const s = await ctx.optionalAuth();
    const hs = ctx.hs;
    let roomId: string;
    try {
      roomId = await hs.rooms.resolveRoomIdOrAlias(ctx.params.roomIdOrAlias);
    } catch {
      throw errors.notFound("Room not found");
    }
    if (!(await hs.rooms.exists(roomId)) || !(await canAccess(hs, roomId, s?.userId ?? null))) throw errors.notFound("Room not found");
    const state = await hs.rooms.currentState(roomId);
    const encryption = stringOrUndefined(getState(state, M.ROOM.ENCRYPTION)?.content?.algorithm);
    const allowed = allowedRoomIds(getState(state, M.ROOM.JOIN_RULES)?.content);
    return {
      ...(await roomDetails(hs, roomId)),
      room_version: await hs.rooms.roomVersion(roomId),
      ...(encryption === undefined ? {} : { encryption }),
      ...(s ? { membership: membershipOf(state, s.userId) } : {}),
      ...(allowed ? { allowed_room_ids: allowed } : {}),
    };
  };
  r.client("GET", "/room_summary/:roomIdOrAlias", procedure({ handler: summary }), ["v1"]);
  // The MSC3266 unstable path, which Element still tries first.
  r.get("/_matrix/client/unstable/im.nheko.summary/summary/:roomIdOrAlias", procedure({ handler: summary }));
}
