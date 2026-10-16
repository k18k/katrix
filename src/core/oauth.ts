import { errors } from "#core/errors.ts";
import { LOCALPART_RE } from "#core/ids.ts";
import type { Homeserver } from "#homeserver.ts";
import type { Session } from "#core/auth.ts";

/**
 * Delegate authentication to an external OAuth 2.0 / OpenID Connect provider
 * (Matrix "OAuth 2.0 API", e.g. matrix-authentication-service, Keycloak, Authentik).
 */
export interface OAuthDelegationOptions {
  /** Issuer URL of the authorization server. */
  issuer: string;
  /** Client credentials the homeserver uses for token introspection. */
  clientId: string;
  clientSecret: string;
  /** Override the introspection endpoint instead of discovering it. */
  introspectionEndpoint?: string;
  /** Where users manage their account (advertised to clients). */
  accountManagementUrl?: string;
  /** Map introspection claims to a Matrix localpart. Default: `username`, then `sub`. */
  localpartFromClaims?: (claims: Record<string, any>) => string | null;
  /** Scope granting server admin rights. Default: "urn:synapse:admin:*". */
  adminScope?: string;
  /** How long successful introspections are cached, in ms. Default: 60 000. */
  cacheTtlMs?: number;
}

const API_SCOPES = ["urn:matrix:client:api:*", "urn:matrix:org.matrix.msc2967.client:api:*"];
const DEVICE_SCOPE_PREFIXES = ["urn:matrix:client:device:", "urn:matrix:org.matrix.msc2967.client:device:"];

export class OAuthDelegation {
  private hs: Homeserver;
  readonly options: OAuthDelegationOptions;
  private metadata: Record<string, any> | null = null;
  private metadataFetched = 0;
  private cache = new Map<string, { session: Session; expires: number }>();

  constructor(hs: Homeserver, options: OAuthDelegationOptions) {
    this.hs = hs;
    this.options = options;
  }

  /** Authorization server metadata (RFC 8414 / OIDC discovery), cached for an hour. */
  async serverMetadata(): Promise<Record<string, any>> {
    if (this.metadata && Date.now() - this.metadataFetched < 3600_000) return this.metadata;
    const base = this.options.issuer.replace(/\/$/, "");
    let res = await this.hs.fetch(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) res = await this.hs.fetch(`${base}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OAuth discovery failed with ${res.status}`);
    const meta = (await res.json()) as Record<string, any>;
    if (this.options.accountManagementUrl) meta.account_management_uri = this.options.accountManagementUrl;
    this.metadata = meta;
    this.metadataFetched = Date.now();
    return meta;
  }

  /** Validate an access token by introspection, provisioning the user and device on first use. */
  async authenticate(token: string): Promise<Session> {
    const cached = this.cache.get(token);
    if (cached && cached.expires > Date.now()) return cached.session;
    const endpoint = this.options.introspectionEndpoint ?? (await this.serverMetadata()).introspection_endpoint;
    if (!endpoint) throw new Error("Authorization server has no introspection endpoint");
    const res = await this.hs.fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`).toString("base64")}`,
      },
      body: new URLSearchParams({ token, token_type_hint: "access_token" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw errors.unknownToken("Token introspection failed");
    const claims = (await res.json()) as Record<string, any>;
    if (!claims.active) throw errors.unknownToken();
    const scopes = String(claims.scope ?? "").split(" ");
    if (!scopes.some((s) => API_SCOPES.includes(s))) throw errors.unknownToken("Token lacks the Matrix API scope");
    let deviceId: string | null = null;
    for (const s of scopes) for (const p of DEVICE_SCOPE_PREFIXES) if (s.startsWith(p)) deviceId = s.slice(p.length);
    if (!deviceId) throw errors.unknownToken("Token lacks a device scope");

    const localpart = (this.options.localpartFromClaims?.(claims) ?? claims.username ?? claims.sub ?? "").toLowerCase();
    if (!LOCALPART_RE.test(localpart)) throw errors.unknownToken("Token subject cannot be mapped to a Matrix user");
    const userId = `@${localpart}:${this.hs.serverName}`;
    let user = await this.hs.db.findOne("users", [{ field: "user_id", value: userId }]);
    if (!user) {
      await this.hs.admin.createUser(localpart, { displayname: claims.name ?? localpart });
      user = await this.hs.db.findOne("users", [{ field: "user_id", value: userId }]);
    }
    if (user!.deactivated) throw errors.userDeactivated();
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
    const session: Session = {
      userId,
      deviceId,
      accessToken: token,
      isGuest: false,
      isAdmin: !!user!.is_admin || scopes.includes(this.options.adminScope ?? "urn:synapse:admin:*"),
    };
    const ttl = this.options.cacheTtlMs ?? 60_000;
    const exp = typeof claims.exp === "number" ? claims.exp * 1000 : Infinity;
    if (this.cache.size > 50_000) this.cache.clear();
    this.cache.set(token, { session, expires: Math.min(Date.now() + ttl, exp) });
    return session;
  }

  forget(token: string): void {
    this.cache.delete(token);
  }
}
