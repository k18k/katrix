import { createHash, randomBytes } from "node:crypto";
import { errors } from "./errors.ts";
import { randomToken, urlSafeBase64 } from "./crypto.ts";
import { LOCALPART_RE } from "./ids.ts";
import type { Homeserver } from "../homeserver.ts";

/** An upstream OpenID Connect provider for `m.login.sso`. */
export interface SsoProvider {
  /** Stable identifier, used in URLs and stored with linked accounts. */
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Default: ["openid", "profile", "email"]. */
  scopes?: string[];
  icon?: string;
  brand?: string;
  /**
   * Map ID token / userinfo claims to a Matrix account. Return a localpart and optional
   * display name, or null to refuse login. Default: sanitised `preferred_username`, then `sub`.
   */
  mapUser?: (claims: Record<string, any>) => { localpart: string; displayname?: string } | null | Promise<{ localpart: string; displayname?: string } | null>;
  /** Create accounts for unknown users. Default: true. */
  allowRegistration?: boolean;
}

export interface SsoOptions {
  providers: SsoProvider[];
}

interface PendingLogin {
  providerId: string;
  redirectUrl: string;
  verifier: string;
  nonce: string;
  expires: number;
}

function sanitizeLocalpart(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9._=\-/+]/g, "_").slice(0, 200);
}

function decodeJwtPayload(jwt: string): Record<string, any> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("Malformed ID token");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/** Upstream OIDC login (authorization code + PKCE) issuing Matrix login tokens. */
export class SsoService {
  private hs: Homeserver;
  readonly providers: SsoProvider[];
  private discovery = new Map<string, Record<string, any>>();

  constructor(hs: Homeserver, options: SsoOptions) {
    this.hs = hs;
    this.providers = options.providers;
  }

  private callbackUrl(provider: SsoProvider): string {
    const base = this.hs.config.publicBaseUrl;
    if (!base) throw new Error("publicBaseUrl is required for SSO");
    return `${base.replace(/\/$/, "")}/_matrix/client/v3/login/sso/callback/${encodeURIComponent(provider.id)}`;
  }

  private async discover(provider: SsoProvider): Promise<Record<string, any>> {
    const cached = this.discovery.get(provider.id);
    if (cached) return cached;
    const res = await this.hs.fetch(`${provider.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OIDC discovery for ${provider.id} failed with ${res.status}`);
    const meta = (await res.json()) as Record<string, any>;
    this.discovery.set(provider.id, meta);
    return meta;
  }

  /** URL to send the user's browser to. */
  async startLogin(providerId: string | null, redirectUrl: string): Promise<string> {
    const provider = providerId ? this.providers.find((p) => p.id === providerId) : this.providers[0];
    if (!provider) throw errors.notFound("Unknown identity provider");
    const meta = await this.discover(provider);
    const state = randomToken(24);
    const verifier = urlSafeBase64(randomBytes(32));
    const nonce = randomToken(16);
    await this.hs.cluster.set(`sso:${state}`, { providerId: provider.id, redirectUrl, verifier, nonce, expires: Date.now() + 10 * 60_000 }, 10 * 60_000);
    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", provider.clientId);
    url.searchParams.set("redirect_uri", this.callbackUrl(provider));
    url.searchParams.set("scope", (provider.scopes ?? ["openid", "profile", "email"]).join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", urlSafeBase64(createHash("sha256").update(verifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /** Handle the provider's redirect; returns the client URL carrying a login token. */
  async finishLogin(providerId: string, params: URLSearchParams): Promise<string> {
    const state = params.get("state") ?? "";
    const pending = await this.hs.cluster.get<PendingLogin>(`sso:${state}`);
    await this.hs.cluster.delete(`sso:${state}`);
    if (!pending || pending.expires < Date.now() || pending.providerId !== providerId) throw errors.forbidden("Unknown or expired login attempt");
    if (params.get("error")) throw errors.forbidden(`Login failed: ${params.get("error")}`);
    const code = params.get("code");
    if (!code) throw errors.missingParam("Missing code");
    const provider = this.providers.find((p) => p.id === providerId)!;
    const meta = await this.discover(provider);

    const body = new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: this.callbackUrl(provider), code_verifier: pending.verifier, client_id: provider.clientId,
    });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (provider.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(provider.clientId)}:${encodeURIComponent(provider.clientSecret)}`).toString("base64")}`;
    }
    const res = await this.hs.fetch(meta.token_endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw errors.forbidden("Code exchange failed");
    const tokens = (await res.json()) as Record<string, any>;

    // The ID token comes straight from the token endpoint over TLS, so its issuer is
    // authenticated by the connection (OIDC Core 3.1.3.7); we still check the claims.
    let claims: Record<string, any> = {};
    if (typeof tokens.id_token === "string") {
      claims = decodeJwtPayload(tokens.id_token);
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== meta.issuer || !aud.includes(provider.clientId)) throw errors.forbidden("ID token issuer or audience mismatch");
      if (claims.nonce !== pending.nonce) throw errors.forbidden("ID token nonce mismatch");
      if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) throw errors.forbidden("ID token expired");
    }
    if (meta.userinfo_endpoint && typeof tokens.access_token === "string") {
      const info = await this.hs.fetch(meta.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10_000) });
      if (info.ok) {
        const userinfo = (await info.json()) as Record<string, any>;
        if (claims.sub && userinfo.sub !== claims.sub) throw errors.forbidden("Userinfo subject mismatch");
        claims = { ...userinfo, ...claims };
      }
    }
    if (typeof claims.sub !== "string") throw errors.forbidden("Provider did not return a subject");

    const userId = await this.resolveUser(provider, claims);
    const loginToken = await this.hs.auth.createLoginToken(userId);
    await this.hs.audit.record({ action: "sso_login", actor: userId, details: { idp: provider.id, subject: claims.sub } });
    const redirect = new URL(pending.redirectUrl);
    redirect.searchParams.set("loginToken", loginToken);
    return redirect.toString();
  }

  private async resolveUser(provider: SsoProvider, claims: Record<string, any>): Promise<string> {
    const link = await this.hs.db.findOne("sso_identities", [{ field: "idp_id", value: provider.id }, { field: "subject", value: claims.sub }]);
    if (link) return link.user_id;
    if (provider.allowRegistration === false) throw errors.forbidden("No account is linked to this identity");
    const mapped = provider.mapUser
      ? await provider.mapUser(claims)
      : { localpart: sanitizeLocalpart(claims.preferred_username ?? claims.sub), displayname: claims.name };
    if (!mapped || !LOCALPART_RE.test(mapped.localpart)) throw errors.forbidden("Could not map identity to a Matrix user");
    let localpart = mapped.localpart;
    // Avoid taking over existing accounts: pick a free localpart.
    for (let i = 1; await this.hs.db.findOne("users", [{ field: "user_id", value: `@${localpart}:${this.hs.serverName}` }]); i++) {
      localpart = `${mapped.localpart}${i}`;
    }
    const userId = await this.hs.admin.createUser(localpart, { displayname: mapped.displayname });
    await this.hs.db.create("sso_identities", { idp_id: provider.id, subject: claims.sub, user_id: userId });
    return userId;
  }
}
