import { errors } from "../core/errors.ts";
import { isObject } from "../core/json.ts";
import type { RequestContext, Router } from "../http/router.ts";

async function requireAdmin(ctx: RequestContext) {
  const s = await ctx.auth();
  if (!s.isAdmin) throw errors.forbidden("You are not a server admin");
  // Every admin API call that changes something is audited.
  if (ctx.method !== "GET") {
    await ctx.hs.audit.record({
      action: "admin_action",
      actor: s.userId,
      ip: ctx.ip,
      details: { method: ctx.method, path: ctx.url.pathname },
    });
  }
  return s;
}

/** Admin HTTP API using Synapse-compatible paths, so existing tooling keeps working. */
export function registerAdminRoutes(r: Router): void {
  const notice = async (ctx: RequestContext) => {
    await requireAdmin(ctx);
    const body = await ctx.json();
    if (typeof body.user_id !== "string" || !isObject(body.content)) throw errors.badJson("user_id and content are required");
    const eventId = await ctx.hs.admin.sendServerNotice(body.user_id, body.content, {
      type: typeof body.type === "string" ? body.type : undefined,
      txnId: ctx.params.txnId,
    });
    return { event_id: eventId };
  };
  // Account moderation (spec v1.18).
  const moderation = (field: "locked" | "suspended") => {
    const target = async (ctx: RequestContext) => {
      await requireAdmin(ctx);
      const userId = ctx.params.userId;
      if (!ctx.hs.isLocalUser(userId)) throw errors.invalidParam("Not a local user");
      const user = await ctx.hs.db.findOne("users", [{ field: "user_id", value: userId }]);
      if (!user) throw errors.notFound("Unknown user");
      return user;
    };
    return {
      get: async (ctx: RequestContext) => ({ [field]: !!(await target(ctx))[field] }),
      put: async (ctx: RequestContext) => {
        await target(ctx);
        const s = await ctx.auth();
        const body = await ctx.json();
        if (typeof body[field] !== "boolean") throw errors.badJson(`${field} must be a boolean`);
        if (field === "locked") await ctx.hs.admin.setLocked(ctx.params.userId, body.locked, s.userId);
        else await ctx.hs.admin.setSuspended(ctx.params.userId, body.suspended, s.userId);
        return { [field]: body[field] };
      },
    };
  };
  const lock = moderation("locked"),
    suspend = moderation("suspended");
  r.get("/_matrix/client/v1/admin/lock/:userId", lock.get);
  r.put("/_matrix/client/v1/admin/lock/:userId", lock.put);
  r.get("/_matrix/client/v1/admin/suspend/:userId", suspend.get);
  r.put("/_matrix/client/v1/admin/suspend/:userId", suspend.put);

  r.post("/_synapse/admin/v1/send_server_notice", notice);
  r.put("/_synapse/admin/v1/send_server_notice/:txnId", notice);

  r.get("/_synapse/admin/v2/users", async (ctx) => {
    await requireAdmin(ctx);
    const from = Number(ctx.query.get("from") ?? 0) || 0;
    const res = await ctx.hs.admin.listUsers({
      from,
      limit: Number(ctx.query.get("limit") ?? 100) || 100,
      search: ctx.query.get("name") ?? undefined,
      includeDeactivated: ctx.query.get("deactivated") === "true",
    });
    return { users: res.users, total: res.total, ...(res.next !== null ? { next_token: String(res.next) } : {}) };
  });
  r.get("/_synapse/admin/v2/users/:userId", async (ctx) => {
    await requireAdmin(ctx);
    const user = await ctx.hs.admin.getUser(ctx.params.userId);
    if (!user) throw errors.notFound("Unknown user");
    return user;
  });
  r.put("/_synapse/admin/v2/users/:userId", async (ctx) => {
    await requireAdmin(ctx);
    const body = await ctx.json();
    const userId = ctx.params.userId;
    if (!ctx.hs.isLocalUser(userId)) throw errors.invalidParam("Can only manage local users");
    const existing = await ctx.hs.admin.getUser(userId);
    if (!existing) {
      await ctx.hs.admin.createUser(userId.slice(1).split(":")[0], {
        password: body.password,
        admin: body.admin === true,
        displayname: body.displayname,
      });
      return new Response(JSON.stringify(await ctx.hs.admin.getUser(userId)), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (typeof body.password === "string") await ctx.hs.admin.resetPassword(userId, body.password, body.logout_devices !== false);
    if (typeof body.admin === "boolean") await ctx.hs.admin.setAdmin(userId, body.admin);
    if (typeof body.displayname === "string") {
      await ctx.hs.db.update("users", [{ field: "user_id", value: userId }], { displayname: body.displayname });
      await ctx.hs.rooms.propagateProfile(userId);
    }
    if (body.deactivated === true) await ctx.hs.admin.deactivateUser(userId);
    return ctx.hs.admin.getUser(userId);
  });
  r.post("/_synapse/admin/v1/deactivate/:userId", async (ctx) => {
    await requireAdmin(ctx);
    const body = await ctx.json();
    await ctx.hs.admin.deactivateUser(ctx.params.userId, { erase: body.erase === true });
    return { id_server_unbind_result: "no-support" };
  });
  r.post("/_synapse/admin/v1/reset_password/:userId", async (ctx) => {
    await requireAdmin(ctx);
    const body = await ctx.json();
    if (typeof body.new_password !== "string") throw errors.missingParam("Missing new_password");
    await ctx.hs.admin.resetPassword(ctx.params.userId, body.new_password, body.logout_devices !== false);
    return {};
  });

  r.get("/_synapse/admin/v1/registration_tokens", async (ctx) => {
    await requireAdmin(ctx);
    return { registration_tokens: await ctx.hs.admin.listRegistrationTokens() };
  });
  r.post("/_synapse/admin/v1/registration_tokens/new", async (ctx) => {
    await requireAdmin(ctx);
    const body = await ctx.json();
    return ctx.hs.admin.createRegistrationToken({
      token: body.token,
      usesAllowed: body.uses_allowed,
      expiryTime: body.expiry_time,
      length: body.length,
    });
  });
  r.delete("/_synapse/admin/v1/registration_tokens/:token", async (ctx) => {
    await requireAdmin(ctx);
    await ctx.hs.admin.deleteRegistrationToken(ctx.params.token);
    return {};
  });

  r.get("/_synapse/admin/v1/audit_log", async (ctx) => {
    await requireAdmin(ctx);
    if (!ctx.hs.audit.enabled) throw errors.unrecognized("The audit log is disabled");
    const rows = await ctx.hs.audit.query({
      actor: ctx.query.get("actor") ?? undefined,
      target: ctx.query.get("target") ?? undefined,
      action: ctx.query.get("action") ?? undefined,
      since: Number(ctx.query.get("since")) || undefined,
      before: Number(ctx.query.get("from")) || undefined,
      limit: Number(ctx.query.get("limit")) || 100,
    });
    const out: Record<string, any> = { entries: rows };
    if (rows.length) out.next_token = String(rows[rows.length - 1].id);
    return out;
  });

  r.get("/_synapse/admin/v1/event_reports", async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.hs.db.findMany("event_reports", {
      sortBy: { field: "id", direction: "desc" },
      limit: Number(ctx.query.get("limit")) || 100,
    });
    return {
      event_reports: rows.map((r) => ({
        id: r.id,
        received_ts: r.ts,
        room_id: r.room_id,
        event_id: r.event_id,
        user_id: r.reporter,
        reason: r.reason,
        score: r.score,
        resolved: r.resolved,
      })),
      total: rows.length,
    };
  });
  r.post("/_synapse/admin/v1/event_reports/:id/resolve", async (ctx) => {
    await requireAdmin(ctx);
    if (!(await ctx.hs.db.update("event_reports", [{ field: "id", value: Number(ctx.params.id) }], { resolved: true })))
      throw errors.notFound("Unknown report");
    return {};
  });

  r.get("/_synapse/admin/v1/rooms", async (ctx) => {
    await requireAdmin(ctx);
    const res = await ctx.hs.admin.listRooms({
      from: Number(ctx.query.get("from") ?? 0) || 0,
      limit: Number(ctx.query.get("limit") ?? 100) || 100,
    });
    return { rooms: res.rooms, total_rooms: res.total };
  });
  r.delete("/_synapse/admin/v1/rooms/:roomId", async (ctx) => {
    const s = await requireAdmin(ctx);
    const body = await ctx.json();
    const { kicked } = await ctx.hs.admin.deleteRoom(ctx.params.roomId, {
      actor: s.userId,
      reason: body.message,
      purge: body.purge !== false,
    });
    return { kicked_users: kicked, failed_to_kick_users: [], local_aliases: [], new_room_id: null };
  });

  r.delete("/_synapse/admin/v1/media/:serverName/:mediaId", async (ctx) => {
    await requireAdmin(ctx);
    if (ctx.params.serverName !== ctx.hs.serverName) throw errors.notFound("Remote media");
    await ctx.hs.admin.deleteMedia(ctx.params.mediaId);
    return { deleted_media: [ctx.params.mediaId], total: 1 };
  });
  r.post("/_synapse/admin/v1/media/delete", async (ctx) => {
    await requireAdmin(ctx);
    const before = Number(ctx.query.get("before_ts"));
    if (!Number.isFinite(before)) throw errors.missingParam("Missing before_ts");
    const deleted = await ctx.hs.admin.purgeMediaBefore(before);
    return { deleted_media: deleted, total: deleted.length };
  });
}
