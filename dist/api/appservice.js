import { errors } from "../core/errors.js";
import { procedure } from "../http/procedure.js";
// src/api/appservice.ts
function registerAppServiceRoutes(r) {
	r.client("POST", "/appservice/:appserviceId/ping", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			if (!s.appservice) throw errors.forbidden("An application service token is required");
			if (s.appservice.id !== ctx.params.appserviceId) throw errors.forbidden("Token does not belong to this application service");
			const body = await ctx.json();
			return { duration_ms: await ctx.hs.appservices.ping(s.appservice, typeof body.transaction_id === "string" ? body.transaction_id : void 0) };
		}
	}), ["v1"]);
	r.client("GET", "/thirdparty/protocols", procedure({
		auth: "user",
		handler: async (ctx) => {
			return ctx.hs.appservices.protocols();
		}
	}));
	r.client("GET", "/thirdparty/protocol/:protocol", procedure({
		auth: "user",
		handler: async (ctx) => {
			const p = (await ctx.hs.appservices.protocols())[ctx.params.protocol];
			if (!p) throw errors.notFound("Unknown protocol");
			return p;
		}
	}));
	for (const kind of ["location", "user"]) {
		r.client("GET", `/thirdparty/${kind}/:protocol`, procedure({
			auth: "user",
			handler: async (ctx) => {
				return ctx.hs.appservices.thirdParty(`${kind}/${encodeURIComponent(ctx.params.protocol)}`, ctx.query);
			}
		}));
		r.client("GET", `/thirdparty/${kind}`, procedure({
			auth: "user",
			handler: async (ctx) => {
				return ctx.hs.appservices.thirdParty(kind, ctx.query);
			}
		}));
	}
}
export { registerAppServiceRoutes };

//# sourceMappingURL=appservice.js.map