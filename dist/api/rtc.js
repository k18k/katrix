import { errors } from "../core/errors.js";
import { procedure } from "../http/procedure.js";
import { v } from "../core/vpm.js";
import { body, fail } from "../http/input.js";
import { createHmac } from "node:crypto";
// src/api/rtc.ts
function registerRtcRoutes(r) {
	r.client("GET", "/voip/turnServer", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const turn = ctx.hs.config.rtc.turn;
			if (!turn || !turn.uris.length) return {};
			if (s.isGuest && !turn.allowGuests) throw errors.forbidden("Guests may not use TURN");
			const ttl = turn.ttlSeconds ?? 86400;
			if (turn.sharedSecret) {
				const username = `${Math.floor(Date.now() / 1e3) + ttl}:${s.userId}`;
				return {
					username,
					password: createHmac("sha1", turn.sharedSecret).update(username).digest("base64"),
					uris: turn.uris,
					ttl
				};
			}
			return {
				username: turn.username ?? "",
				password: turn.password ?? "",
				uris: turn.uris,
				ttl
			};
		}
	}));
	const transports = async (ctx) => {
		await ctx.auth();
		return { rtc_transports: ctx.hs.config.rtc.transports ?? [] };
	};
	r.client("GET", "/rtc/transports", procedure({ handler: transports }), ["v1"]);
	r.get("/_matrix/client/unstable/org.matrix.msc4143/rtc/transports", procedure({ handler: transports }));
	const base = "/_matrix/client/unstable/org.matrix.msc4140/delayed_events";
	r.get(base, procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			return { delayed_events: await ctx.hs.delayedEvents.list(s.userId) };
		}
	}));
	r.post(`${base}/:delayId`, procedure({
		auth: "user",
		input: body({ action: v.string(fail("M_MISSING_PARAM", "Missing action")) }),
		handler: async (ctx) => {
			const s = ctx.session;
			await ctx.hs.delayedEvents.update(s.userId, ctx.params.delayId, ctx.input.action);
			return {};
		}
	}));
	r.post(`${base}/:delayId/:action`, procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			await ctx.hs.delayedEvents.update(s.userId, ctx.params.delayId, ctx.params.action);
			return {};
		}
	}));
}
export { registerRtcRoutes };

//# sourceMappingURL=rtc.js.map