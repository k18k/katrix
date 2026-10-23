import { MatrixError, errors } from "../core/errors.ts";
import { getState } from "../core/authrules.ts";
import { isValidUserId } from "../core/ids.ts";
import { isObject } from "../core/json.ts";
import { assertNotSuspended, type Session } from "../core/auth.ts";
import type { RequestContext, Router } from "../http/router.ts";
import { procedure, type ProcedureContext } from "../http/procedure.ts";
import { v } from "../core/vpm.ts";
import { body, lenient } from "../http/input.ts";
import { M } from "../core/m.ts";
import { requireRoom } from "./rooms.ts";

// Room membership: join, knock, invite (also by third-party identifier), leave, kick, ban, unban, forget.

/**
 * Invite by email address or phone number (spec "Third-party invites"): invite the Matrix user the
 * identity server knows for it, or store the invite there and emit an m.room.third_party_invite.
 */
async function inviteByThreepid(ctx: RequestContext, s: Session, body: Record<string, any>): Promise<Record<string, never>> {
  const hs = ctx.hs;
  const roomId = ctx.params.roomId;
  for (const k of ["id_server", "id_access_token", "medium", "address"]) {
    if (typeof body[k] !== "string") throw errors.missingParam(`Missing ${k}`);
  }
  await requireRoom(hs, roomId);
  await hs.rooms.requireJoined(roomId, s.userId);
  const mxid = await hs.identityServers.lookup(body.id_server, body.id_access_token, body.medium, body.address);
  if (mxid) {
    if ((await hs.rooms.membership(roomId, mxid)) === "ban") throw errors.forbidden("User is banned");
    await hs.rooms.invite(roomId, s.userId, mxid);
    return {};
  }
  const state = await hs.rooms.currentState(roomId);
  const profile = await hs.profile(s.userId);
  const create = getState(state, M.ROOM.CREATE, "");
  const invite: Record<string, unknown> = {
    medium: body.medium,
    address: body.address,
    room_id: roomId,
    sender: s.userId,
    room_alias: getState(state, M.ROOM.CANONICAL_ALIAS, "")?.content?.alias,
    room_avatar_url: getState(state, M.ROOM.AVATAR, "")?.content?.url,
    room_join_rules: getState(state, M.ROOM.JOIN_RULES, "")?.content?.join_rule,
    room_name: getState(state, M.ROOM.NAME, "")?.content?.name,
    room_type: create?.content?.type,
    sender_display_name: profile.displayname,
    sender_avatar_url: profile.avatar_url,
  };
  for (const k of Object.keys(invite)) if (invite[k] === undefined || invite[k] === null) delete invite[k];
  const stored = await hs.identityServers.storeInvite(body.id_server, body.id_access_token, invite);
  const [first] = stored.public_keys;
  await hs.rooms.sendEvent(roomId, s.userId, {
    type: M.ROOM.THIRD_PARTY_INVITE,
    state_key: stored.token,
    content: {
      display_name: stored.display_name,
      key_validity_url: first?.key_validity_url,
      public_key: first?.public_key,
      public_keys: stored.public_keys,
    },
  });
  return {};
}

const membershipBody = body({ user_id: lenient(v.string()), reason: lenient(v.string()) });

async function sendMembership(
  ctx: ProcedureContext<"user", v.output<typeof membershipBody>>,
  membership: "leave" | "ban" | "unban" | "kick",
): Promise<Record<string, never>> {
  const s = ctx.session;
  const roomId = ctx.params.roomId;
  // Leaving (and rejecting invites) stays possible while suspended; moderating others does not.
  if (membership !== "leave") await assertNotSuspended(ctx.hs, s, roomId);
  const body = ctx.input;
  const hs = ctx.hs;
  const reason = body.reason;
  if (membership === "leave") {
    // For rooms this server is not in (remote invites/knocks), the membership row is authoritative.
    const row = await hs.db.findOne("memberships", [
      { field: "room_id", value: roomId },
      { field: "user_id", value: s.userId },
    ]);
    if (!(await hs.rooms.exists(roomId)) && !row) throw errors.notFound("Room not found");
    const current = (await hs.rooms.serverIsJoined(roomId)) ? await hs.rooms.membership(roomId, s.userId) : (row?.membership ?? "leave");
    if (current === "leave") return {};
    if (current === "ban") throw errors.forbidden("You are banned from this room");
    if (current === "invite" && (await hs.admin.isNoticeRoom(roomId))) {
      throw new MatrixError(403, "M_CANNOT_LEAVE_SERVER_NOTICE_ROOM", "Server notice invites cannot be rejected");
    }
    await hs.rooms.setMembership(roomId, s.userId, s.userId, "leave", reason);
    return {};
  }
  if (!body.user_id || !isValidUserId(body.user_id)) throw errors.invalidParam("Invalid user_id");
  const target = body.user_id;
  await requireRoom(hs, roomId);
  if (membership === "unban") {
    if ((await hs.rooms.membership(roomId, target)) !== "ban") throw errors.forbidden("User is not banned");
    await hs.rooms.setMembership(roomId, s.userId, target, "leave", reason);
  } else if (membership === "kick") {
    const current = await hs.rooms.membership(roomId, target);
    if (current === "leave" || current === "ban") throw errors.forbidden("User is not in the room");
    await hs.rooms.setMembership(roomId, s.userId, target, "leave", reason);
  } else {
    await hs.rooms.setMembership(roomId, s.userId, target, "ban", reason);
  }
  await hs.audit.record({
    action: membership === "kick" ? "member_kick" : membership === "ban" ? "member_ban" : "member_unban",
    actor: s.userId,
    target: body.user_id,
    ip: ctx.ip,
    details: { room_id: roomId, reason },
  });
  return {};
}

export function registerMembershipRoutes(r: Router): void {
  // Unknown keys of a join request become part of the membership event's content.
  const joinBody = body({ reason: lenient(v.string()), third_party_signed: v.unknown().optional() });
  const join = async (ctx: ProcedureContext<"user", v.output<typeof joinBody>>, idOrAlias: string) => {
    const s = ctx.session;
    const body = ctx.input;
    const { roomId, servers: resolvedServers } = await ctx.hs.rooms.resolveRoom(idOrAlias);
    await assertNotSuspended(ctx.hs, s, roomId);
    const { reason, membership, join_authorised_via_users_server, third_party_signed, ...custom } = body;
    const servers = [...ctx.query.getAll("via"), ...ctx.query.getAll("server_name"), ...resolvedServers];
    // Joining with an identity server's proof first turns the pending third-party invite into an invite.
    if (isObject(third_party_signed)) {
      const signed = third_party_signed as Record<string, any>;
      if (typeof signed.sender !== "string" || signed.mxid !== s.userId || typeof signed.token !== "string")
        throw errors.badJson("Invalid third_party_signed");
      // The identity server's signature covers the whole object (sender included): pass it on unchanged.
      const sender: string = signed.sender;
      const proof = signed;
      if ((await ctx.hs.rooms.membership(roomId, s.userId)) !== "invite") {
        const event = {
          type: M.ROOM.MEMBER,
          room_id: roomId,
          sender,
          state_key: s.userId,
          content: { membership: "invite", third_party_invite: { signed: proof } },
        };
        if (ctx.hs.isLocalUser(sender)) {
          const pending = getState(await ctx.hs.rooms.currentState(roomId), M.ROOM.THIRD_PARTY_INVITE, signed.token);
          if (!pending || pending.sender !== sender) throw errors.forbidden("No such third-party invite");
          await ctx.hs.rooms.invite(roomId, sender, s.userId, {
            thirdPartyInvite: { display_name: pending.content?.display_name ?? "", signed: proof },
          });
        } else {
          await ctx.hs.federation.client.request(
            sender.slice(sender.indexOf(":") + 1),
            "PUT",
            `/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(roomId)}`,
            { body: event },
          );
        }
      }
    }
    await ctx.hs.rooms.join(s.userId, roomId, { reason, content: custom, servers });
    return { room_id: roomId };
  };
  r.client(
    "POST",
    "/rooms/:roomId/join",
    procedure({ auth: "user", rateLimit: "join", input: joinBody, handler: (ctx) => join(ctx, ctx.params.roomId) }),
  );
  r.client(
    "POST",
    "/join/:roomIdOrAlias",
    procedure({ auth: "user", rateLimit: "join", input: joinBody, handler: (ctx) => join(ctx, ctx.params.roomIdOrAlias) }),
  );

  r.client(
    "POST",
    "/knock/:roomIdOrAlias",
    procedure({
      auth: "user",
      input: body({ reason: lenient(v.string()) }),
      handler: async (ctx) => {
        const s = ctx.session;
        const body = ctx.input;
        const { roomId, servers } = await ctx.hs.rooms.resolveRoom(ctx.params.roomIdOrAlias);
        await assertNotSuspended(ctx.hs, s, roomId);
        const via = [...ctx.query.getAll("via"), ...ctx.query.getAll("server_name"), ...servers];
        await ctx.hs.rooms.setMembership(roomId, s.userId, s.userId, "knock", body.reason, via);
        return { room_id: roomId };
      },
    }),
  );

  // Third-party invites (id_server, medium, address...) are checked in inviteByThreepid.
  const inviteBody = body({ user_id: lenient(v.string()), reason: lenient(v.string()) });
  r.client(
    "POST",
    "/rooms/:roomId/invite",
    procedure({
      auth: "user",
      input: inviteBody,
      handler: async (ctx) => {
        const s = ctx.session;
        const body = ctx.input;
        await assertNotSuspended(ctx.hs, s, ctx.params.roomId);
        await ctx.rateLimit("invite");
        if (body.id_server !== undefined || body.medium !== undefined) return inviteByThreepid(ctx, s, body);
        if (!body.user_id || !isValidUserId(body.user_id)) throw errors.invalidParam("Invalid user_id");
        await requireRoom(ctx.hs, ctx.params.roomId);
        const current = await ctx.hs.rooms.membership(ctx.params.roomId, body.user_id);
        if (current === "ban") throw errors.forbidden("User is banned");
        if (current === "join") throw errors.forbidden("User is already joined");
        await ctx.hs.rooms.invite(ctx.params.roomId, s.userId, body.user_id, { reason: body.reason });
        return {};
      },
    }),
  );

  r.client(
    "POST",
    "/rooms/:roomId/leave",
    procedure({ auth: "user", input: membershipBody, handler: (ctx) => sendMembership(ctx, "leave") }),
  );
  r.client(
    "POST",
    "/rooms/:roomId/kick",
    procedure({ auth: "user", input: membershipBody, handler: (ctx) => sendMembership(ctx, "kick") }),
  );
  r.client("POST", "/rooms/:roomId/ban", procedure({ auth: "user", input: membershipBody, handler: (ctx) => sendMembership(ctx, "ban") }));
  r.client(
    "POST",
    "/rooms/:roomId/unban",
    procedure({ auth: "user", input: membershipBody, handler: (ctx) => sendMembership(ctx, "unban") }),
  );

  r.client(
    "POST",
    "/rooms/:roomId/forget",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const hs = ctx.hs;
        const row = await hs.db.findOne("memberships", [
          { field: "room_id", value: ctx.params.roomId },
          { field: "user_id", value: s.userId },
        ]);
        if (!row) throw errors.notFound("Not a member of this room");
        if (row.membership === "join" || row.membership === "invite" || row.membership === "knock") {
          throw errors.unknown("You must leave the room before forgetting it");
        }
        await hs.db.update(
          "memberships",
          [
            { field: "room_id", value: ctx.params.roomId },
            { field: "user_id", value: s.userId },
          ],
          { forgotten: true },
        );
        return {};
      },
    }),
  );
}
