import { assertNotSuspended } from "#core/auth.ts";
import { getState } from "#core/authrules.ts";
import { MatrixError, errors } from "#core/errors.ts";
import { isValidUserId } from "#core/ids.ts";
import { isObject } from "#core/json.ts";
import { BUILTIN_FIELDS, MAX_KEY_BYTES, MAX_PROFILE_BYTES, fullProfile, profileSize, setProfileField } from "#core/profile.ts";
import type { RequestContext, Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import { z } from "zod";
import { body, fail, lenient } from "#http/input.ts";

async function remoteProfile(ctx: RequestContext, field?: string): Promise<Record<string, any>> {
  if (!isValidUserId(ctx.params.userId)) throw errors.invalidParam("Invalid user ID");
  try {
    const res = await ctx.hs.federation.queryProfile(ctx.params.userId, field);
    return isObject(res) ? res : {};
  } catch (err) {
    if (err instanceof MatrixError && err.status === 404) throw errors.notFound("Profile not found");
    throw err;
  }
}

async function localProfile(ctx: RequestContext): Promise<Record<string, unknown>> {
  const profile = await fullProfile(ctx.hs, ctx.params.userId);
  if (!profile) throw errors.notFound("Profile not found");
  return profile;
}

function checkField(field: string): void {
  if (!field || Buffer.byteLength(field) > MAX_KEY_BYTES) throw new MatrixError(400, "M_KEY_TOO_LARGE", "Profile key too long");
}

export function registerProfileRoutes(r: Router): void {
  r.client(
    "GET",
    "/profile/:userId",
    procedure({
      handler: async (ctx) => {
        if (!ctx.hs.isLocalUser(ctx.params.userId)) return remoteProfile(ctx);
        return localProfile(ctx);
      },
    }),
  );

  r.client(
    "GET",
    "/profile/:userId/:field",
    procedure({
      handler: async (ctx) => {
        const field = ctx.params.field;
        checkField(field);
        const profile = ctx.hs.isLocalUser(ctx.params.userId) ? await localProfile(ctx) : await remoteProfile(ctx, field);
        if (profile[field] === undefined || profile[field] === null) throw errors.notFound("Profile field not set");
        return { [field]: profile[field] };
      },
    }),
  );

  async function owner(ctx: RequestContext) {
    const s = await ctx.auth();
    if (!isValidUserId(ctx.params.userId) || ctx.params.userId !== s.userId) throw errors.forbidden("Cannot change another user's profile");
    checkField(ctx.params.field);
    await assertNotSuspended(ctx.hs, s);
    return s;
  }

  r.client(
    "PUT",
    "/profile/:userId/:field",
    procedure({
      handler: async (ctx) => {
        const s = await owner(ctx);
        const field = ctx.params.field;
        const body = await ctx.json();
        if (!isObject(body) || !(field in body)) throw errors.badJson(`Body must contain ${field}`);
        if (Object.keys(body).length !== 1) throw errors.badJson("Body must contain only the profile field");
        const value = body[field];
        if (BUILTIN_FIELDS.has(field)) {
          if (value !== null && typeof value !== "string") throw errors.badJson(`${field} must be a string`);
          if (typeof value === "string" && value.length > 1024) throw errors.tooLarge(`${field} too long`);
        }
        const profile = (await fullProfile(ctx.hs, s.userId)) ?? {};
        profile[field] = value;
        if (profileSize(profile) > MAX_PROFILE_BYTES) throw new MatrixError(400, "M_PROFILE_TOO_LARGE", "Profile too large");
        await setProfileField(ctx.hs, s.userId, field, value);
        return {};
      },
    }),
  );

  r.client(
    "DELETE",
    "/profile/:userId/:field",
    procedure({
      handler: async (ctx) => {
        const s = await owner(ctx);
        await setProfileField(ctx.hs, s.userId, ctx.params.field, null);
        return {};
      },
    }),
  );

  const directoryBody = body({ search_term: z.string(fail("M_MISSING_PARAM", "Missing search_term")), limit: lenient(z.number().int()) });
  r.client(
    "POST",
    "/user_directory/search",
    procedure({
      auth: "user",
      input: directoryBody,
      handler: async (ctx) => {
        const s = ctx.session;
        const body = ctx.input;
        const term = body.search_term.toLowerCase();
        const limit = body.limit !== undefined ? Math.min(body.limit, 50) : 10;
        // Users are discoverable if they share a room with the searcher or are in a public room
        // (so the searcher only finds themselves through a public room, as in Synapse).
        const visible = await ctx.hs.rooms.usersSharingRooms(s.userId);
        visible.delete(s.userId);
        // A room is public here if anyone may join it or read its history (published or not).
        for (const room of await ctx.hs.db.findMany("rooms", {})) {
          const state = await ctx.hs.rooms.currentState(room.room_id);
          const isPublic =
            room.is_public ||
            getState(state, "m.room.join_rules")?.content?.join_rule === "public" ||
            getState(state, "m.room.history_visibility")?.content?.history_visibility === "world_readable";
          if (isPublic) for (const u of await ctx.hs.rooms.joinedMembers(room.room_id)) visible.add(u);
        }
        const users = await ctx.hs.db.findMany("users", {
          where: [{ field: "user_id", operator: "in", value: [...visible].filter((u) => ctx.hs.isLocalUser(u)) }],
        });
        const candidates: { user_id: string; displayname?: string | null; avatar_url?: string | null }[] = users
          .filter((u) => !u.deactivated)
          .map((u) => ({ user_id: u.user_id, displayname: u.displayname, avatar_url: u.avatar_url }));
        // Remote users are known through their membership events.
        for (const userId of visible) {
          if (ctx.hs.isLocalUser(userId)) continue;
          const row = (
            await ctx.hs.db.findMany("memberships", {
              where: [
                { field: "user_id", value: userId },
                { field: "membership", value: "join" },
              ],
              limit: 1,
            })
          )[0];
          const member = row ? await ctx.hs.rooms.getPdu(row.event_id) : null;
          candidates.push({ user_id: userId, displayname: member?.content?.displayname, avatar_url: member?.content?.avatar_url });
        }
        const results = candidates
          .filter(
            (u) =>
              u.user_id.toLowerCase().includes(term) || (typeof u.displayname === "string" && u.displayname.toLowerCase().includes(term)),
          )
          .map((u) => ({ user_id: u.user_id, display_name: u.displayname ?? undefined, avatar_url: u.avatar_url ?? undefined }));
        return { results: results.slice(0, limit), limited: results.length > limit };
      },
    }),
  );

  r.client(
    "GET",
    "/presence/:userId/status",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const row = await ctx.hs.db.findOne("presence", [{ field: "user_id", value: ctx.params.userId }]);
        if (!row) {
          if (!(await ctx.hs.db.findOne("users", [{ field: "user_id", value: ctx.params.userId }]))) throw errors.notFound("Unknown user");
          return { presence: "offline" };
        }
        const out: Record<string, any> = { presence: row.presence, last_active_ago: Date.now() - row.last_active_ts };
        if (row.status_msg) out.status_msg = row.status_msg;
        if (row.presence === "online") out.currently_active = true;
        return out;
      },
    }),
  );

  r.client(
    "PUT",
    "/presence/:userId/status",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        if (ctx.params.userId !== s.userId) throw errors.forbidden("Cannot set another user's presence");
        const body = await ctx.json();
        if (!["online", "offline", "unavailable"].includes(body.presence)) throw errors.invalidParam("Invalid presence");
        await ctx.hs.streams.write((stream) =>
          ctx.hs.db.upsert("presence", {
            user_id: s.userId,
            presence: body.presence,
            status_msg: typeof body.status_msg === "string" ? body.status_msg : null,
            last_active_ts: Date.now(),
            stream,
          }),
        );
        await ctx.hs.federation
          .onPresence(s.userId, body.presence, typeof body.status_msg === "string" ? body.status_msg : null)
          .catch(() => {});
        ctx.hs.notifier.notify(await ctx.hs.rooms.usersSharingRooms(s.userId));
        return {};
      },
    }),
  );
}
