import { errors } from "#core/errors.ts";
import { LOCALPART_RE } from "#core/ids.ts";
const API_SCOPES = ["urn:matrix:client:api:*", "urn:matrix:org.matrix.msc2967.client:api:*"];
const DEVICE_SCOPE_PREFIXES = ["urn:matrix:client:device:", "urn:matrix:org.matrix.msc2967.client:device:"];
export class OAuthDelegation {
    hs;
    options;
    metadata = null;
    metadataFetched = 0;
    cache = new Map();
    constructor(hs, options) {
        this.hs = hs;
        this.options = options;
    }
    /** Authorization server metadata (RFC 8414 / OIDC discovery), cached for an hour. */
    async serverMetadata() {
        if (this.metadata && Date.now() - this.metadataFetched < 3600_000)
            return this.metadata;
        const base = this.options.issuer.replace(/\/$/, "");
        let res = await this.hs.fetch(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok)
            res = await this.hs.fetch(`${base}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok)
            throw new Error(`OAuth discovery failed with ${res.status}`);
        const meta = (await res.json());
        if (this.options.accountManagementUrl)
            meta.account_management_uri = this.options.accountManagementUrl;
        this.metadata = meta;
        this.metadataFetched = Date.now();
        return meta;
    }
    /** Validate an access token by introspection, provisioning the user and device on first use. */
    async authenticate(token) {
        const cached = this.cache.get(token);
        if (cached && cached.expires > Date.now())
            return cached.session;
        const endpoint = this.options.introspectionEndpoint ?? (await this.serverMetadata()).introspection_endpoint;
        if (!endpoint)
            throw new Error("Authorization server has no introspection endpoint");
        const res = await this.hs.fetch(endpoint, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`).toString("base64")}`,
            },
            body: new URLSearchParams({ token, token_type_hint: "access_token" }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok)
            throw errors.unknownToken("Token introspection failed");
        const claims = (await res.json());
        if (!claims.active)
            throw errors.unknownToken();
        const scopes = String(claims.scope ?? "").split(" ");
        if (!scopes.some((s) => API_SCOPES.includes(s)))
            throw errors.unknownToken("Token lacks the Matrix API scope");
        let deviceId = null;
        for (const s of scopes)
            for (const p of DEVICE_SCOPE_PREFIXES)
                if (s.startsWith(p))
                    deviceId = s.slice(p.length);
        if (!deviceId)
            throw errors.unknownToken("Token lacks a device scope");
        const localpart = (this.options.localpartFromClaims?.(claims) ?? claims.username ?? claims.sub ?? "").toLowerCase();
        if (!LOCALPART_RE.test(localpart))
            throw errors.unknownToken("Token subject cannot be mapped to a Matrix user");
        const userId = `@${localpart}:${this.hs.serverName}`;
        let user = await this.hs.db.findOne("users", [{ field: "user_id", value: userId }]);
        if (!user) {
            await this.hs.admin.createUser(localpart, { displayname: claims.name ?? localpart });
            user = await this.hs.db.findOne("users", [{ field: "user_id", value: userId }]);
        }
        if (user.deactivated)
            throw errors.userDeactivated();
        const deviceWhere = [
            { field: "user_id", value: userId },
            { field: "device_id", value: deviceId },
        ];
        if (!(await this.hs.db.findOne("devices", deviceWhere))) {
            await this.hs.db.create("devices", {
                user_id: userId,
                device_id: deviceId,
                display_name: null,
                last_seen_ts: Date.now(),
                last_seen_ip: null,
            });
            await this.hs.keys.markDeviceListChanged(userId);
        }
        const session = {
            userId,
            deviceId,
            accessToken: token,
            isGuest: false,
            isAdmin: !!user.is_admin || scopes.includes(this.options.adminScope ?? "urn:synapse:admin:*"),
            oauth: true,
        };
        const ttl = this.options.cacheTtlMs ?? 60_000;
        const exp = typeof claims.exp === "number" ? claims.exp * 1000 : Infinity;
        if (this.cache.size > 50_000)
            this.cache.clear();
        this.cache.set(token, { session, expires: Math.min(Date.now() + ttl, exp) });
        return session;
    }
    forget(token) {
        this.cache.delete(token);
    }
}
