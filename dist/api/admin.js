import { errors } from "../core/errors.js";
import { v } from "../core/vpm.js";
import { body, fail, lenient } from "../http/input.js";
import { procedure } from "../http/procedure.js";
import { allowCrossSigningReset } from "../core/oauthserver.js";
// src/api/admin.ts
const required = fail("M_BAD_JSON", "user_id and content are required");
const noticeBody = body({
	user_id: v.string(required),
	content: v.looseObject({}, required),
	type: lenient(v.string())
});
const optionalInt = (name) => v.number(fail("M_INVALID_PARAM", `${name} must be an integer`)).int(`M_INVALID_PARAM: ${name} must be an integer`);
const registrationTokenBody = body({
	token: v.string(fail("M_INVALID_PARAM", "Invalid token")).optional(),
	uses_allowed: optionalInt("uses_allowed").nullable().optional(),
	expiry_time: optionalInt("expiry_time").nullable().optional(),
	length: optionalInt("length").optional()
});
async function requireAdmin(ctx) {
	const s = await ctx.auth();
	if (!s.isAdmin) throw errors.forbidden("You are not a server admin");
	if (ctx.method !== "GET") await ctx.hs.audit.record({
		action: "admin_action",
		actor: s.userId,
		ip: ctx.ip,
		details: {
			method: ctx.method,
			path: ctx.url.pathname
		}
	});
	return s;
}
const adminGuard = async (ctx) => {
	await requireAdmin(ctx);
	return {};
};
/** Admin HTTP API using Synapse-compatible paths, so existing tooling keeps working. */
function registerAdminRoutes(r) {
	const notice = async (ctx) => {
		const body = ctx.input;
		return { event_id: await ctx.hs.admin.sendServerNotice(body.user_id, body.content, {
			type: body.type,
			txnId: ctx.params.txnId
		}) };
	};
	const moderation = (field) => {
		const target = async (ctx) => {
			await requireAdmin(ctx);
			const userId = ctx.params.userId;
			if (!ctx.hs.isLocalUser(userId)) throw errors.invalidParam("Not a local user");
			const user = await ctx.hs.db.findOne("users", [{
				field: "user_id",
				value: userId
			}]);
			if (!user) throw errors.notFound("Unknown user");
			return user;
		};
		return {
			get: async (ctx) => ({ [field]: !!(await target(ctx))[field] }),
			put: async (ctx) => {
				await target(ctx);
				const s = await ctx.auth();
				const body = await ctx.json();
				if (typeof body[field] !== "boolean") throw errors.badJson(`${field} must be a boolean`);
				if (field === "locked") await ctx.hs.admin.setLocked(ctx.params.userId, body.locked, s.userId);
				else await ctx.hs.admin.setSuspended(ctx.params.userId, body.suspended, s.userId);
				return { [field]: body[field] };
			}
		};
	};
	const lock = moderation("locked"), suspend = moderation("suspended");
	r.get("/_matrix/client/v1/admin/lock/:userId", procedure({ handler: lock.get }));
	r.put("/_matrix/client/v1/admin/lock/:userId", procedure({ handler: lock.put }));
	r.get("/_matrix/client/v1/admin/suspend/:userId", procedure({ handler: suspend.get }));
	r.put("/_matrix/client/v1/admin/suspend/:userId", procedure({ handler: suspend.put }));
	r.post("/_synapse/admin/v1/send_server_notice", procedure({
		guard: adminGuard,
		input: noticeBody,
		handler: notice
	}));
	r.put("/_synapse/admin/v1/send_server_notice/:txnId", procedure({
		guard: adminGuard,
		input: noticeBody,
		handler: notice
	}));
	r.get("/_synapse/admin/v2/users", procedure({ handler: async (ctx) => {
		await requireAdmin(ctx);
		const from = Number(ctx.query.get("from") ?? 0) || 0;
		const res = await ctx.hs.admin.listUsers({
			from,
			limit: Number(ctx.query.get("limit") ?? 100) || 100,
			search: ctx.query.get("name") ?? void 0,
			includeDeactivated: ctx.query.get("deactivated") === "true"
		});
		return {
			users: res.users,
			total: res.total,
			...res.next !== null ? { next_token: String(res.next) } : {}
		};
	} }));
	r.get("/_synapse/admin/v2/users/:userId", procedure({ handler: async (ctx) => {
		await requireAdmin(ctx);
		const user = await ctx.hs.admin.getUser(ctx.params.userId);
		if (!user) throw errors.notFound("Unknown user");
		return user;
	} }));
	r.put("/_synapse/admin/v2/users/:userId", procedure({ handler: async (ctx) => {
		await requireAdmin(ctx);
		const body = await ctx.json();
		const userId = ctx.params.userId;
		if (!ctx.hs.isLocalUser(userId)) throw errors.invalidParam("Can only manage local users");
		if (!await ctx.hs.admin.getUser(userId)) {
			await ctx.hs.admin.createUser(userId.slice(1).split(":")[0], {
				password: body.password,
				admin: body.admin === true,
				displayname: body.displayname
			});
			return new Response(JSON.stringify(await ctx.hs.admin.getUser(userId)), {
				status: 201,
				headers: { "content-type": "application/json" }
			});
		}
		if (typeof body.password === "string") await ctx.hs.admin.resetPassword(userId, body.password, body.logout_devices !== false);
		if (typeof body.admin === "boolean") await ctx.hs.admin.setAdmin(userId, body.admin);
		if (typeof body.displayname === "string") {
			await ctx.hs.db.update("users", [{
				field: "user_id",
				value: userId
			}], { displayname: body.displayname });
			await ctx.hs.rooms.propagateProfile(userId);
		}
		if (body.deactivated === true) await ctx.hs.admin.deactivateUser(userId);
		return ctx.hs.admin.getUser(userId);
	} }));
	r.post("/_synapse/admin/v1/join/:roomIdOrAlias", procedure({
		guard: adminGuard,
		input: body({ user_id: v.string(fail("M_MISSING_PARAM", "user_id is required", "user_id")) }),
		handler: async (ctx) => ({ room_id: await ctx.hs.admin.joinUser(ctx.input.user_id, ctx.params.roomIdOrAlias) })
	}));
	r.post("/_synapse/admin/v1/users/:userId/_allow_cross_signing_replacement_without_uia", procedure({
		guard: adminGuard,
		handler: async (ctx) => {
			const userId = ctx.params.userId;
			if (!ctx.hs.isLocalUser(userId) || !await ctx.hs.admin.getUser(userId)) throw errors.notFound("Unknown user");
			return { updatable_without_uia_before_ms: await allowCrossSigningReset(ctx.hs, userId) };
		}
	}));
	r.post("/_synapse/admin/v1/deactivate/:userId", procedure({
		guard: adminGuard,
		input: body({ erase: lenient(v.boolean()) }),
		handler: async (ctx) => {
			const body = ctx.input;
			await ctx.hs.admin.deactivateUser(ctx.params.userId, { erase: body.erase === true });
			return { id_server_unbind_result: "no-support" };
		}
	}));
	const resetPasswordBody = body({
		new_password: v.string(fail("M_MISSING_PARAM", "Missing new_password")),
		logout_devices: lenient(v.boolean())
	});
	r.post("/_synapse/admin/v1/reset_password/:userId", procedure({
		guard: adminGuard,
		input: resetPasswordBody,
		handler: async (ctx) => {
			const body = ctx.input;
			await ctx.hs.admin.resetPassword(ctx.params.userId, body.new_password, body.logout_devices !== false);
			return {};
		}
	}));
	r.get("/_synapse/admin/v1/registration_tokens", procedure({ handler: async (ctx) => {
		await requireAdmin(ctx);
		return { registration_tokens: await ctx.hs.admin.listRegistrationTokens() };
	} }));
	r.post("/_synapse/admin/v1/registration_tokens/new", procedure({
		guard: adminGuard,
		input: registrationTokenBody,
		handler: async (ctx) => {
			const body = ctx.input;
			return ctx.hs.admin.createRegistrationToken({
				token: body.token,
				usesAllowed: body.uses_allowed,
				expiryTime: body.expiry_time,
				length: body.length
			});
		}
	}));
	r.delete("/_synapse/admin/v1/registration_tokens/:token", procedure({ handler: async (ctx) => {
		await requireAdmin(ctx);
		await ctx.hs.admin.deleteRegistrationToken(ctx.params.token);
		return {};
	} }));
	r.get("/_synapse/admin/v1/audit_log", procedure({ handler: async (ctx) => {
		await requireAdmin(ctx);
		if (!ctx.hs.audit.enabled) throw errors.unrecognized("The audit log is disabled");
		const rows = await ctx.hs.audit.query({
			actor: ctx.query.get("actor") ?? void 0,
			target: ctx.query.get("target") ?? void 0,
			action: ctx.query.get("action") ?? void 0,
			since: Number(ctx.query.get("since")) || void 0,
			before: Number(ctx.query.get("from")) || void 0,
			limit: Number(ctx.query.get("limit")) || 100
		});
		const out = { entries: rows };
		if (rows.length) out.next_token = String(rows[rows.length - 1].id);
		return out;
	} }));
	r.get("/_synapse/admin/v1/event_reports", procedure({ handler: async (ctx) => {
		await requireAdmin(ctx);
		const rows = await ctx.hs.db.findMany("event_reports", {
			sortBy: {
				field: "id",
				direction: "desc"
			},
			limit: Number(ctx.query.get("limit")) || 100
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
				resolved: r.resolved
			})),
			total: rows.length
		};
	} }));
	r.post("/_synapse/admin/v1/event_reports/:id/resolve", procedure({ handler: async (ctx) => {
		await requireAdmin(ctx);
		if (!await ctx.hs.db.update("event_reports", [{
			field: "id",
			value: Number(ctx.params.id)
		}], { resolved: true })) throw errors.notFound("Unknown report");
		return {};
	} }));
	r.get("/_synapse/admin/v1/rooms", procedure({ handler: async (ctx) => {
		await requireAdmin(ctx);
		const res = await ctx.hs.admin.listRooms({
			from: Number(ctx.query.get("from") ?? 0) || 0,
			limit: Number(ctx.query.get("limit") ?? 100) || 100
		});
		return {
			rooms: res.rooms,
			total_rooms: res.total
		};
	} }));
	r.delete("/_synapse/admin/v1/rooms/:roomId", procedure({ handler: async (ctx) => {
		const s = await requireAdmin(ctx);
		const body = await ctx.json();
		const { kicked } = await ctx.hs.admin.deleteRoom(ctx.params.roomId, {
			actor: s.userId,
			reason: body.message,
			purge: body.purge !== false
		});
		return {
			kicked_users: kicked,
			failed_to_kick_users: [],
			local_aliases: [],
			new_room_id: null
		};
	} }));
	r.delete("/_synapse/admin/v1/media/:serverName/:mediaId", procedure({ handler: async (ctx) => {
		await requireAdmin(ctx);
		if (ctx.params.serverName !== ctx.hs.serverName) throw errors.notFound("Remote media");
		await ctx.hs.admin.deleteMedia(ctx.params.mediaId);
		return {
			deleted_media: [ctx.params.mediaId],
			total: 1
		};
	} }));
	r.post("/_synapse/admin/v1/media/delete", procedure({ handler: async (ctx) => {
		await requireAdmin(ctx);
		const before = Number(ctx.query.get("before_ts"));
		if (!Number.isFinite(before)) throw errors.missingParam("Missing before_ts");
		const deleted = await ctx.hs.admin.purgeMediaBefore(before);
		return {
			deleted_media: deleted,
			total: deleted.length
		};
	} }));
}
export { registerAdminRoutes };

//# sourceMappingURL=admin.js.map