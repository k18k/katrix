import { M, UNSTABLE } from "../packages/shared/src/m.js";
import { errors } from "../core/errors.js";
import { signJson } from "../core/crypto.js";
import { SUPPORTED_ROOM_VERSIONS } from "../core/events.js";
import { procedure } from "../http/procedure.js";
import { canonicalJsonResponse } from "../http/handler.js";
import { wellKnown } from "./account.js";
import { readFileSync } from "node:fs";
// src/api/misc.ts
const PACKAGE = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const SPEC_VERSIONS = [
	"r0.0.1",
	"r0.1.0",
	"r0.2.0",
	"r0.3.0",
	"r0.4.0",
	"r0.5.0",
	"r0.6.0",
	"r0.6.1",
	"v1.1",
	"v1.2",
	"v1.3",
	"v1.4",
	"v1.5",
	"v1.6",
	"v1.7",
	"v1.8",
	"v1.9",
	"v1.10",
	"v1.11",
	"v1.12",
	"v1.13",
	"v1.14",
	"v1.15",
	"v1.16",
	"v1.17",
	"v1.18",
	"v1.19"
];
function registerMiscRoutes(r) {
	r.get("/_matrix/client/versions", procedure({ handler: () => ({
		versions: SPEC_VERSIONS,
		unstable_features: {
			[UNSTABLE.ORG.MATRIX.SIMPLIFIED_MSC3575]: true,
			[UNSTABLE.ORG.MATRIX.MSC3916.STABLE]: true,
			[UNSTABLE.ORG.MATRIX.MSC4140._]: true,
			[UNSTABLE.ORG.MATRIX.MSC4143._]: true,
			[UNSTABLE.ORG.MATRIX.MSC4222._]: true,
			[UNSTABLE.ORG.MATRIX.MSC4306]: true
		}
	}) }));
	r.get("/.well-known/matrix/client", procedure({ handler: (ctx) => {
		const wk = wellKnown(ctx.hs);
		if (!wk) throw errors.notFound("No well-known configured");
		return wk;
	} }));
	r.get("/.well-known/matrix/server", procedure({ handler: (ctx) => {
		if (!ctx.hs.config.federationAddress) throw errors.notFound("No delegation configured");
		return { [M.SERVER]: ctx.hs.config.federationAddress };
	} }));
	r.get("/.well-known/matrix/support", procedure({ handler: (ctx) => {
		if (!ctx.hs.config.support) throw errors.notFound("No support information configured");
		return ctx.hs.config.support;
	} }));
	r.client("GET", "/capabilities", procedure({
		auth: "user",
		handler: async (ctx) => {
			const available = {};
			for (const v of SUPPORTED_ROOM_VERSIONS) available[v] = /^\d+$/.test(v) ? "stable" : "unstable";
			return { capabilities: {
				[M.CHANGE_PASSWORD]: { enabled: !ctx.hs.oauth && !ctx.session.oauth && ctx.hs.userAuth.passwordLoginEnabled },
				[M.ROOM_VERSIONS]: {
					default: ctx.hs.config.defaultRoomVersion,
					available
				},
				[M.SET_DISPLAYNAME]: { enabled: true },
				[M.SET_AVATAR_URL]: { enabled: true },
				[M.PROFILE_FIELDS]: { enabled: true },
				[M.THREEPID_CHANGES]: { enabled: ctx.hs.threepids.enabled && !ctx.hs.oauth && !ctx.session.oauth },
				[M.GET_LOGIN_TOKEN]: { enabled: ctx.hs.config.loginViaExistingSession && !ctx.hs.oauth && !ctx.session.oauth }
			} };
		}
	}));
	r.get("/_matrix/key/v2/server", procedure({ handler: (ctx) => {
		const hs = ctx.hs;
		const key = hs.signingKey;
		return canonicalJsonResponse(signJson({
			server_name: hs.serverName,
			valid_until_ts: Date.now() + 864e5,
			verify_keys: { [`ed25519:${key.keyId}`]: { key: key.publicKeyBase64 } },
			old_verify_keys: {}
		}, hs.serverName, key));
	} }));
	r.get("/_matrix/federation/v1/version", procedure({ handler: (ctx) => {
		if (!ctx.hs.federation.enabled) throw errors.unrecognized("Federation is disabled");
		return { server: {
			name: PACKAGE.name,
			version: PACKAGE.version
		} };
	} }));
}
export { SPEC_VERSIONS, registerMiscRoutes };

//# sourceMappingURL=misc.js.map