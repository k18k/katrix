import { isObject, isStrings, isValidAlias, isValidRoomId, M, parseId } from "@katrix/shared";
import { MatrixError, errors } from "#core/errors.ts";
import { getState, membershipOf, powerLevels, userLevel } from "#core/authrules.ts";
import { type Session } from "#core/auth.ts";
import type { Homeserver } from "#homeserver.ts";
import type { Row } from "#storage/types.ts";
import type { RequestContext, Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import { body } from "#http/input.ts";
import { visibleState } from "#api/rooms.ts";
import { roomDetails } from "#api/spaces.ts";

// Room aliases and the room directory (also for application services), local and over federation.

async function publicRooms(ctx: RequestContext, body: Record<string, unknown>) {
  const hs = ctx.hs;
  const limit = Number(body.limit ?? ctx.query.get("limit") ?? 0) || undefined;
  const since = body.since ?? ctx.query.get("since");
  const offset = since ? Number.parseInt(String(since).replace(/^o/, ""), 10) || 0 : 0;
  const term =
    isObject(body.filter) && typeof body.filter.generic_search_term === "string" ? body.filter.generic_search_term.toLowerCase() : null;
  const listed = isObject(body.filter) ? body.filter.room_types : undefined;
  const roomTypes: unknown[] | null = Array.isArray(listed) ? listed : null;
  const rooms = await hs.db.findMany("rooms", {
    where: [{ field: "is_public", value: true }],
    sortBy: { field: "created_ts", direction: "asc" },
  });
  // https://github.com/k18k/katrix/issues/128: a copy of roomDetails (api/spaces.ts) built as Record<string, any> was used here.
  let chunks = await Promise.all(rooms.map((r) => roomDetails(hs, r.room_id)));
  if (term)
    chunks = chunks.filter((c) =>
      [c.name, c.topic, c.canonical_alias].some((v) => typeof v === "string" && v.toLowerCase().includes(term)),
    );
  if (roomTypes) chunks = chunks.filter((c) => roomTypes.includes(c.room_type ?? null));
  chunks.sort((a, b) => b.num_joined_members - a.num_joined_members);
  const page = limit ? chunks.slice(offset, offset + limit) : chunks.slice(offset);
  return {
    chunk: page,
    total_room_count_estimate: chunks.length,
    ...(limit && offset + limit < chunks.length ? { next_batch: `o${offset + limit}` } : {}),
    ...(offset > 0 ? { prev_batch: `o${Math.max(0, offset - (limit ?? 0))}` } : {}),
  };
}

async function canDeleteAlias(hs: Homeserver, s: Session, alias: Row): Promise<boolean> {
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
          // https://github.com/k18k/katrix/issues/129: the alias was deleted from a mutable copy; the new content is built without it.
          const { alias, ...rest } = canonical.content;
          const alt = rest.alt_aliases;
          const inAlt = isStrings(alt) && alt.includes(ctx.params.alias);
          const content = {
            ...rest,
            ...(alias !== ctx.params.alias && alias !== undefined && { alias }),
            ...(inAlt && { alt_aliases: alt.filter((a) => a !== ctx.params.alias) }),
          };
          if (alias === ctx.params.alias || inAlt) {
            // https://github.com/k18k/katrix/issues/125: background failures here were discarded with .catch(() => {}), so a lost publish or
            // federation update left no trace; they are logged now, and deliberate ones carry a ts-pro-exception.
            await ctx.hs.rooms
              .sendEvent(row.room_id, s.userId, { type: M.ROOM.CANONICAL_ALIAS, state_key: "", content })
              .catch((err) => ctx.hs.logger.warn("Removing the deleted alias from the canonical alias event failed", err));
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
        if (body.visibility !== "public" && body.visibility !== "private") throw errors.invalidParam("Invalid visibility");
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

  const remoteOrLocal = async (ctx: RequestContext, body: Record<string, unknown>) => {
    const server = ctx.query.get("server");
    if (server && server !== ctx.hs.serverName) {
      const limit = ctx.query.get("limit");
      const since = ctx.query.get("since");
      return ctx.hs.federation.queryPublicRooms(server, {
        ...body,
        ...(limit ? { limit: Number(limit) } : {}),
        ...(since ? { since } : {}),
      });
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
        if (body.visibility !== "public" && body.visibility !== "private") throw errors.invalidParam("Invalid visibility");
        if (!(await ctx.hs.rooms.exists(ctx.params.roomId))) throw errors.notFound("Room not found");
        await ctx.hs.db.update("rooms", [{ field: "room_id", value: ctx.params.roomId }], { is_public: body.visibility === "public" });
        return {};
      },
    }),
  );
}
