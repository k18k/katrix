import { isObject, isValidUserId, M } from "@katrix/shared";
import type { Homeserver } from "#homeserver.ts";
import { assertNotSuspended } from "#core/auth.ts";
import { getState } from "#core/authrules.ts";
import { MatrixError, errors } from "#core/errors.ts";
import { BUILTIN_FIELDS, MAX_KEY_BYTES, MAX_PROFILE_BYTES, fullProfile, profileSize, setProfileField } from "#core/profile.ts";
import type { RequestContext, Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import { v } from "#core/vpm.ts";
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

/** How long the members of public rooms are reused by the user directory. */
const PUBLIC_MEMBERS_MS = 30_000;
const publicMembersCache = new WeakMap<Homeserver, { at: number; users: Promise<Set<string>> }>();
const watched = new WeakSet<Homeserver>();
const DIRECTORY_STATE = new Set<string>([M.ROOM.MEMBER, M.ROOM.JOIN_RULES, M.ROOM.HISTORY_VISIBILITY]);

/**
 * Members of public rooms: anyone may join them or read their history (published or not).
 *
 * https://github.com/k18k/katrix/issues/107: every directory search read every room's state and
 * public rooms' members, and each remote candidate's membership one by one, before applying its limit, so any
 * user could make the server walk all of it per request. This set is reused for 30 seconds (someone joining a
 * public room on another instance shows up that much later; on this one, at once), and remote memberships are read
 * in a batch.
 * shortcut: still one pass over all rooms per 30 s and instance; a directory table kept up to date as memberships
 * change would replace it if servers grow to many rooms.
 */
function publicRoomMembers(hs: Homeserver): Promise<Set<string>> {
  if (!watched.has(hs)) {
    watched.add(hs);
    const forget = () => publicMembersCache.delete(hs);
    hs.on("event", (ev: { type: string; state_key?: string }) => {
      if (ev.state_key !== undefined && DIRECTORY_STATE.has(ev.type)) forget();
    });
    hs.cluster.subscribe("partial-state", forget);
  }
  const cached = publicMembersCache.get(hs);
  if (cached && Date.now() - cached.at < PUBLIC_MEMBERS_MS) return cached.users;
  const users = (async () => {
    const out = new Set<string>();
    for (const room of await hs.db.findMany("rooms", {})) {
      const state = await hs.rooms.currentState(room.room_id);
      const isPublic =
        room.is_public ||
        getState(state, M.ROOM.JOIN_RULES)?.content?.join_rule === "public" ||
        getState(state, M.ROOM.HISTORY_VISIBILITY)?.content?.history_visibility === "world_readable";
      if (isPublic) for (const u of await hs.rooms.joinedMembers(room.room_id)) out.add(u);
    }
    return out;
  })();
  users.catch(() => publicMembersCache.delete(hs));
  publicMembersCache.set(hs, { at: Date.now(), users });
  return users;
}

export function registerProfileRoutes(r: Router): void {
  r.client(
    "GET",
    "/profile/:userId",
    procedure({
      endpoint: "GET /v3/profile/:userId",
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

  const directoryBody = body({ search_term: v.string(fail("M_MISSING_PARAM", "Missing search_term")), limit: lenient(v.number().int()) });
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
        for (const u of await publicRoomMembers(ctx.hs)) visible.add(u);
        const users = await ctx.hs.db.findMany("users", {
          where: [{ field: "user_id", operator: "in", value: [...visible].filter((u) => ctx.hs.isLocalUser(u)) }],
        });
        const candidates: { user_id: string; displayname?: string | null; avatar_url?: string | null }[] = users
          .filter((u) => !u.deactivated)
          .map((u) => ({ user_id: u.user_id, displayname: u.displayname, avatar_url: u.avatar_url }));
        // Remote users are known through their membership events (read in one batch each, #107).
        const remote = [...visible].filter((u) => !ctx.hs.isLocalUser(u));
        const rows = remote.length
          ? await ctx.hs.db.findMany("memberships", {
              where: [
                { field: "user_id", operator: "in", value: remote },
                { field: "membership", value: "join" },
              ],
            })
          : [];
        const eventOf = new Map<string, string>();
        for (const row of rows) if (!eventOf.has(row.user_id)) eventOf.set(row.user_id, row.event_id);
        const members = await ctx.hs.rooms.getPdus([...eventOf.values()]);
        for (const userId of remote) {
          const member = members.get(eventOf.get(userId) ?? "");
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
