import { M } from "../shared/m.js";
import { MatrixError, errors } from "../core/errors.js";
import { canonicalAddress, isMedium } from "../core/threepid.js";
import { v } from "../core/vpm.js";
import { body, fail, lenient } from "../http/input.js";
import { procedure } from "../http/procedure.js";
import { requireUia } from "./uia.js";
// src/api/threepid.ts
const submitField = v.string(fail("M_MISSING_PARAM", "sid, client_secret and token are required"));
const submitBody = body({
	sid: submitField,
	client_secret: submitField,
	token: submitField
});
const bindField = (name) => v.string(fail("M_MISSING_PARAM", `Missing ${name}`));
const bindBody = body({
	client_secret: bindField("client_secret"),
	id_access_token: bindField("id_access_token"),
	id_server: bindField("id_server"),
	sid: bindField("sid")
});
const threepidBody = body({
	medium: v.enum(["email", "msisdn"], fail("M_INVALID_PARAM", "Unsupported medium")),
	address: v.string(fail("M_INVALID_PARAM", "Invalid address")),
	id_server: v.string(fail("M_INVALID_PARAM", "id_server must be a string")).optional()
});
function notDelegated(ctx) {
	if (ctx.hs.oauth) throw errors.unrecognized("Managed by the OAuth provider");
}
function registerThreepidRoutes(r) {
	const requestToken = (purpose, medium) => async (ctx) => {
		notDelegated(ctx);
		await ctx.rateLimit(purpose === "register" ? "register" : "login");
		return ctx.hs.threepids.requestToken(purpose, medium, ctx.input);
	};
	for (const medium of ["email", "msisdn"]) {
		r.client("POST", `/register/${medium}/requestToken`, procedure({
			input: body({}),
			handler: requestToken("register", medium)
		}));
		r.client("POST", `/account/password/${medium}/requestToken`, procedure({
			input: body({}),
			handler: requestToken("password_reset", medium)
		}));
		r.client("POST", `/account/3pid/${medium}/requestToken`, procedure({
			input: body({}),
			handler: requestToken("add_threepid", medium)
		}));
	}
	const submitPath = "/_matrix/client/unstable/threepid/submit_token";
	r.get(submitPath, procedure({ handler: async (ctx) => {
		const q = ctx.query;
		let nextLink = null;
		let message = "Your address has been validated. You can return to your Matrix client.";
		let status = 200;
		try {
			nextLink = await ctx.hs.threepids.submitToken(q.get("sid") ?? "", q.get("client_secret") ?? "", q.get("token") ?? "");
		} catch (err) {
			message = err instanceof MatrixError ? `Validation failed: ${err.message}.` : "Validation failed.";
			status = 400;
		}
		if (nextLink && status === 200) return Response.redirect(nextLink, 302);
		return new Response(`<!doctype html><meta charset="utf-8"><title>${ctx.hs.serverName}</title><p>${message}</p>`, {
			status,
			headers: { "content-type": "text/html; charset=utf-8" }
		});
	} }));
	r.post(submitPath, procedure({
		input: submitBody,
		handler: async (ctx) => {
			const body = ctx.input;
			await ctx.hs.threepids.submitToken(body.sid, body.client_secret, body.token);
			return { success: true };
		}
	}));
	r.client("GET", "/account/3pid", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			return { threepids: await ctx.hs.threepids.list(s.userId) };
		}
	}));
	r.client("POST", "/account/3pid/add", procedure({
		input: body({
			sid: lenient(v.string()),
			client_secret: lenient(v.string())
		}),
		handler: async (ctx) => {
			notDelegated(ctx);
			const s = await ctx.auth();
			const body = ctx.input;
			await requireUia(ctx.hs, body, [[M.LOGIN.PASSWORD]], s.userId, { session: s });
			const validated = await ctx.hs.threepids.validated({
				sid: body.sid,
				client_secret: body.client_secret
			});
			if (!validated) throw new MatrixError(400, "M_THREEPID_AUTH_FAILED", "The address has not been validated");
			await ctx.hs.threepids.add(s.userId, validated);
			return {};
		}
	}));
	r.client("POST", "/account/3pid/bind", procedure({
		auth: "user",
		input: bindBody,
		handler: async (ctx) => {
			const s = ctx.session;
			const body = ctx.input;
			const res = await ctx.hs.identityServers.bind(body.id_server, body.id_access_token, body.sid, body.client_secret, s.userId);
			if (res && isMedium(res.medium) && typeof res.address === "string") await ctx.hs.db.upsert("threepid_bindings", {
				user_id: s.userId,
				medium: res.medium,
				address: res.address,
				id_server: body.id_server
			});
			return {};
		}
	}));
	const parseThreepid = (body) => {
		const address = canonicalAddress(body.medium, body.address);
		if (!address) throw errors.invalidParam("Invalid address");
		return {
			medium: body.medium,
			address,
			idServer: body.id_server
		};
	};
	r.client("POST", "/account/3pid/delete", procedure({
		input: threepidBody,
		handler: async (ctx) => {
			notDelegated(ctx);
			const s = await ctx.auth();
			const { medium, address, idServer } = parseThreepid(ctx.input);
			const result = await ctx.hs.threepids.unbindAll(s.userId, medium, address, idServer);
			await ctx.hs.threepids.remove(s.userId, medium, address);
			return { id_server_unbind_result: result };
		}
	}));
	r.client("POST", "/account/3pid/unbind", procedure({
		auth: "user",
		input: threepidBody,
		handler: async (ctx) => {
			const s = ctx.session;
			const { medium, address, idServer } = parseThreepid(ctx.input);
			return { id_server_unbind_result: await ctx.hs.threepids.unbindAll(s.userId, medium, address, idServer) };
		}
	}));
	r.client("POST", "/account/3pid", procedure({
		auth: "user",
		handler: async () => {
			throw errors.threepidDenied();
		}
	}));
}
export { registerThreepidRoutes };

//# sourceMappingURL=threepid.js.map