import { isObject, stringOrUndefined } from "../packages/shared/src/json.js";
import { LOCALPART_RE } from "../packages/shared/src/ids.js";
import { errors } from "./errors.js";
// src/core/oauth.ts
async function jsonObject(res) {
	const value = await res.json().catch(() => void 0);
	return isObject(value) ? value : {};
}
const API_SCOPES = ["urn:matrix:client:api:*", "urn:matrix:org.matrix.msc2967.client:api:*"];
const DEVICE_SCOPE_PREFIXES = ["urn:matrix:client:device:", "urn:matrix:org.matrix.msc2967.client:device:"];
var OAuthDelegation = class {
	hs;
	options;
	metadata = null;
	metadataFetched = 0;
	cache = /* @__PURE__ */ new Map();
	constructor(hs, options) {
		this.hs = hs;
		this.options = options;
	}
	/** Authorization server metadata (RFC 8414 / OIDC discovery), cached for an hour. */
	async serverMetadata() {
		if (this.metadata && Date.now() - this.metadataFetched < 36e5) return this.metadata;
		const base = this.options.issuer.replace(/\/$/, "");
		let res = await this.hs.fetch(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(1e4) });
		if (!res.ok) res = await this.hs.fetch(`${base}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(1e4) });
		if (!res.ok) throw new Error(`OAuth discovery failed with ${res.status}`);
		const discovered = await jsonObject(res);
		const managed = this.options.accountManagementUrl;
		const meta = managed ? {
			...discovered,
			account_management_uri: managed
		} : discovered;
		this.metadata = meta;
		this.metadataFetched = Date.now();
		return meta;
	}
	/** Validate an access token by introspection, provisioning the user and device on first use. */
	async authenticate(token) {
		const cached = this.cache.get(token);
		if (cached && cached.expires > Date.now()) return cached.session;
		const endpoint = this.options.introspectionEndpoint ?? stringOrUndefined((await this.serverMetadata()).introspection_endpoint);
		if (!endpoint) throw new Error("Authorization server has no introspection endpoint");
		const res = await this.hs.fetch(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`).toString("base64")}`
			},
			body: new URLSearchParams({
				token,
				token_type_hint: "access_token"
			}),
			signal: AbortSignal.timeout(1e4)
		});
		if (!res.ok) throw errors.unknownToken("Token introspection failed");
		const claims = await jsonObject(res);
		if (claims.active !== true) throw errors.unknownToken();
		const scopes = (stringOrUndefined(claims.scope) ?? "").split(" ");
		if (!scopes.some((s) => API_SCOPES.includes(s))) throw errors.unknownToken("Token lacks the Matrix API scope");
		let deviceId = null;
		for (const s of scopes) for (const p of DEVICE_SCOPE_PREFIXES) if (s.startsWith(p)) deviceId = s.slice(p.length);
		if (!deviceId) throw errors.unknownToken("Token lacks a device scope");
		const localpart = (this.options.localpartFromClaims?.(claims) ?? stringOrUndefined(claims.username) ?? stringOrUndefined(claims.sub) ?? "").toLowerCase();
		if (!LOCALPART_RE.test(localpart)) throw errors.unknownToken("Token subject cannot be mapped to a Matrix user");
		const userId = `@${localpart}:${this.hs.serverName}`;
		let user = await this.hs.db.findOne("users", [{
			field: "user_id",
			value: userId
		}]);
		if (!user) {
			await this.hs.admin.createUser(localpart, { displayname: stringOrUndefined(claims.name) ?? localpart });
			user = await this.hs.db.findOne("users", [{
				field: "user_id",
				value: userId
			}]);
		}
		if (user.deactivated) throw errors.userDeactivated();
		const deviceWhere = [{
			field: "user_id",
			value: userId
		}, {
			field: "device_id",
			value: deviceId
		}];
		if (!await this.hs.db.findOne("devices", deviceWhere)) {
			await this.hs.db.create("devices", {
				user_id: userId,
				device_id: deviceId,
				display_name: null,
				last_seen_ts: Date.now(),
				last_seen_ip: null
			});
			await this.hs.keys.markDeviceListChanged(userId);
		}
		const session = {
			userId,
			deviceId,
			accessToken: token,
			isGuest: false,
			isAdmin: !!user.is_admin || scopes.includes(this.options.adminScope ?? "urn:synapse:admin:*"),
			oauth: true
		};
		const ttl = this.options.cacheTtlMs ?? 6e4;
		const exp = typeof claims.exp === "number" ? claims.exp * 1e3 : Infinity;
		if (this.cache.size > 5e4) this.cache.clear();
		this.cache.set(token, {
			session,
			expires: Math.min(Date.now() + ttl, exp)
		});
		return session;
	}
	forget(token) {
		this.cache.delete(token);
	}
};
export { OAuthDelegation };

//# sourceMappingURL=oauth.js.map