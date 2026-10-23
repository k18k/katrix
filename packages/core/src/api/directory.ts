import { MatrixError, errors } from "../core/errors.ts";
import { getState, membershipOf, powerLevels, userLevel } from "../core/authrules.ts";
import { isValidAlias, isValidRoomId, parseId } from "../core/ids.ts";
import { isObject } from "../core/json.ts";
import { type Session } from "../core/auth.ts";
import type { Homeserver } from "../homeserver.ts";
import type { RequestContext, Router } from "../http/router.ts";
import { procedure } from "../http/procedure.ts";
import { body } from "../http/input.ts";
import { M } from "../core/m.ts";
import { visibleState } from "./rooms.ts";

// Room aliases and the room directory (also for application services), local and over federation.

async function publicRoomChunk(hs: Homeserver, roomId: string): Promise<Record<string, any>> {
  const state = await hs.rooms.currentState(roomId);
  const get = (t: string) => getState(state, t)?.content;
  const chunk: Record<string, any> = {
    room_id: roomId,
    num_joined_members: (await hs.rooms.joinedMembers(roomId)).length,
    world_readable: get(M.ROOM.HISTORY_VISIBILITY)?.history_visibility === "world_readable",
    guest_can_join: get(M.ROOM.GUEST_ACCESS)?.guest_access === "can_join",
    join_rule: get(M.ROOM.JOIN_RULES)?.join_rule ?? "invite",
  };
  if (typeof get(M.ROOM.NAME)?.name === "string") chunk.name = get(M.ROOM.NAME)!.name;
  if (typeof get(M.ROOM.TOPIC)?.topic === "string") chunk.topic = get(M.ROOM.TOPIC)!.topic;
  if (typeof get(M.ROOM.CANONICAL_ALIAS)?.alias === "string") chunk.canonical_alias = get(M.ROOM.CANONICAL_ALIAS)!.alias;
  if (typeof get(M.ROOM.AVATAR)?.url === "string") chunk.avatar_url = get(M.ROOM.AVATAR)!.url;
  const roomType = get(M.ROOM.CREATE)?.type;
  if (typeof roomType === "string") chunk.room_type = roomType;
  return chunk;
}

async function publicRooms(ctx: RequestContext, body: Record<string, any>) {
  const hs = ctx.hs;
  const limit = Number(body.limit ?? ctx.query.get("limit") ?? 0) || undefined;
  const since = body.since ?? ctx.query.get("since");
  const offset = since ? Number.parseInt(String(since).replace(/^o/, ""), 10) || 0 : 0;
  const term =
    isObject(body.filter) && typeof body.filter.generic_search_term === "string" ? body.filter.generic_search_term.toLowerCase() : null;
  const roomTypes = isObject(body.filter) && Array.isArray(body.filter.room_types) ? body.filter.room_types : null;
  const rooms = await hs.db.findMany("rooms", {
    where: [{ field: "is_public", value: true }],
    sortBy: { field: "created_ts", direction: "asc" },
  });
  let chunks = await Promise.all(rooms.map((r) => publicRoomChunk(hs, r.room_id)));
  if (term)
    chunks = chunks.filter((c) =>
      [c.name, c.topic, c.canonical_alias].some((v) => typeof v === "string" && v.toLowerCase().includes(term)),
    );
  if (roomTypes) chunks = chunks.filter((c) => roomTypes.includes(c.room_type ?? null));
  chunks.sort((a, b) => b.num_joined_members - a.num_joined_members);
  const page = limit ? chunks.slice(offset, offset + limit) : chunks.slice(offset);
  const out: Record<string, any> = { chunk: page, total_room_count_estimate: chunks.length };
  if (limit && offset + limit < chunks.length) out.next_batch = `o${offset + limit}`;
  if (offset > 0) out.prev_batch = `o${Math.max(0, offset - (limit ?? 0))}`;
  return out;
}

async function canDeleteAlias(hs: Homeserver, s: Session, alias: Record<string, any>): Promise<boolean> {
  if (alias.creator === s.userId || s.isAdmin) return true;
  const version = await hs.rooms.roomVersion(alias.room_id);
  if (!version) return false;
  const state = await hs.rooms.currentState(alias.room_id);
  const pl = powerLevels(state, version);
  const needed = pl.events[M.ROOM.CANONICAL_ALIAS] ?? pl.state_default;
  return membershipOf(state, s.userId) === "join" && userLevel(pl, s.userId) >= needed;
}

export function registerDirectoryRoutes(r: Router): void {
  // --- Aliases & directory ---------------------------------------------------

  r.client(
    "GET",
    "/directory/room/:alias",
    procedure({
      handler: async (ctx) => {
        if (!isValidAlias(ctx.params.alias)) throw errors.invalidParam("Invalid alias");
        const { roomId, servers } = await ctx.hs.rooms.resolveRoom(ctx.params.alias);
        const inRoom = (await ctx.hs.rooms.exists(roomId))
          ? [...(await ctx.hs.federation.roomDestinations(roomId, await ctx.hs.rooms.currentState(roomId)))]
          : [];
        return { room_id: roomId, servers: [...new Set([...servers, ...inRoom])] };
      },
    }),
  );

  r.client(
    "PUT",
    "/directory/room/:alias",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const body = await ctx.json();
        const alias = ctx.params.alias;
        if (!isValidAlias(alias) || /\s/.test(alias)) throw errors.invalidParam("Invalid alias");
        if (parseId(alias, "#")!.server !== ctx.hs.serverName) throw errors.invalidParam("Alias must be on this server");
        if (!isValidRoomId(body.room_id)) throw errors.invalidParam("Invalid room_id");
        if (!(await ctx.hs.rooms.exists(body.room_id))) throw errors.notFound("Room not found");
        const owner = ctx.hs.appservices.exclusiveAliasOwner(alias);
        if (owner && s.appservice !== owner) throw errors.exclusive("This alias is reserved by an application service");
        if (await ctx.hs.db.findOne("room_aliases", [{ field: "alias", value: alias }])) {
          throw new MatrixError(409, "M_UNKNOWN", "Room alias already exists");
        }
        await ctx.hs.db.create("room_aliases", { alias, room_id: body.room_id, creator: s.userId });
        return {};
      },
    }),
  );

  r.client(
    "DELETE",
    "/directory/room/:alias",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const row = await ctx.hs.db.findOne("room_aliases", [{ field: "alias", value: ctx.params.alias }]);
        if (!row) throw errors.notFound("Room alias not found");
        if (!(await canDeleteAlias(ctx.hs, s, row))) throw errors.forbidden("You may not delete this alias");
        await ctx.hs.db.delete("room_aliases", [{ field: "alias", value: ctx.params.alias }]);
        // Remove the alias from the room's canonical alias event, too.
        const canonical = getState(await ctx.hs.rooms.currentState(row.room_id), M.ROOM.CANONICAL_ALIAS);
        if (canonical) {
          const content = { ...canonical.content };
          let changed = false;
          if (content.alias === ctx.params.alias) {
            delete content.alias;
            changed = true;
          }
          if (Array.isArray(content.alt_aliases) && content.alt_aliases.includes(ctx.params.alias)) {
            content.alt_aliases = content.alt_aliases.filter((a: string) => a !== ctx.params.alias);
            changed = true;
          }
          if (changed) {
            await ctx.hs.rooms.sendEvent(row.room_id, s.userId, { type: M.ROOM.CANONICAL_ALIAS, state_key: "", content }).catch(() => {});
          }
        }
        return {};
      },
    }),
  );

  r.client(
    "GET",
    "/rooms/:roomId/aliases",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        await visibleState(ctx.hs, ctx.params.roomId, s.userId);
        const rows = await ctx.hs.db.findMany("room_aliases", { where: [{ field: "room_id", value: ctx.params.roomId }] });
        return { aliases: rows.map((r) => r.alias) };
      },
    }),
  );

  r.client(
    "GET",
    "/directory/list/room/:roomId",
    procedure({
      handler: async (ctx) => {
        const row = await ctx.hs.db.findOne("rooms", [{ field: "room_id", value: ctx.params.roomId }]);
        if (!row) throw errors.notFound("Room not found");
        return { visibility: row.is_public ? "public" : "private" };
      },
    }),
  );

  r.client(
    "PUT",
    "/directory/list/room/:roomId",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const body = await ctx.json();
        if (!["public", "private"].includes(body.visibility)) throw errors.invalidParam("Invalid visibility");
        const version = await ctx.hs.rooms.roomVersion(ctx.params.roomId);
        if (!version) throw errors.notFound("Room not found");
        const state = await ctx.hs.rooms.requireJoined(ctx.params.roomId, s.userId);
        const pl = powerLevels(state, version);
        if (!s.isAdmin && userLevel(pl, s.userId) < (pl.events[M.ROOM.CANONICAL_ALIAS] ?? pl.state_default)) {
          throw errors.forbidden("Insufficient power level");
        }
        await ctx.hs.db.update("rooms", [{ field: "room_id", value: ctx.params.roomId }], { is_public: body.visibility === "public" });
        return {};
      },
    }),
  );

  const remoteOrLocal = async (ctx: RequestContext, body: Record<string, any>) => {
    const server = ctx.query.get("server");
    if (server && server !== ctx.hs.serverName) {
      const query: Record<string, any> = { ...body };
      if (ctx.query.get("limit")) query.limit = Number(ctx.query.get("limit"));
      if (ctx.query.get("since")) query.since = ctx.query.get("since");
      return ctx.hs.federation.queryPublicRooms(server, query);
    }
    return publicRooms(ctx, body);
  };
  r.client("GET", "/publicRooms", procedure({ handler: (ctx) => remoteOrLocal(ctx, {}) }));
  // The directory query (limit, since, filter...) is read leniently by remoteOrLocal.
  r.client(
    "POST",
    "/publicRooms",
    procedure({
      auth: "user",
      input: body({}),
      handler: async (ctx) => {
        return remoteOrLocal(ctx, ctx.input);
      },
    }),
  );

  // Application service network-specific room directory.
  r.client(
    "PUT",
    "/directory/list/appservice/:networkId/:roomId",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        if (!s.appservice) throw errors.forbidden("Only application services may use this endpoint");
        const body = await ctx.json();
        if (!["public", "private"].includes(body.visibility)) throw errors.invalidParam("Invalid visibility");
        if (!(await ctx.hs.rooms.exists(ctx.params.roomId))) throw errors.notFound("Room not found");
        await ctx.hs.db.update("rooms", [{ field: "room_id", value: ctx.params.roomId }], { is_public: body.visibility === "public" });
        return {};
      },
    }),
  );
}
