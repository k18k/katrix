import { createHash, randomBytes } from "node:crypto";
import { errors } from "./errors.ts";
import { randomToken, urlSafeBase64 } from "./crypto.ts";
import { LOCALPART_RE } from "./ids.ts";
import type { Homeserver } from "../homeserver.ts";

/**
 * An upstream identity provider: OpenID Connect (found through `issuer`), or plain OAuth 2.0 with
 * a user info endpoint (`endpoints`, e.g. GitHub; see `githubProvider`).
 */
export interface SsoProvider {
  /** Stable identifier, used in URLs and stored with linked accounts. */
  id: string;
  name: string;
  /** OpenID Connect issuer; its discovery document gives the endpoints. Required without `endpoints`. */
  issuer?: string;
  /** Endpoints of a provider without OpenID Connect discovery. */
  endpoints?: { authorization: string; token: string; userinfo?: string };
  clientId: string;
  clientSecret?: string;
  /** Default: ["openid", "profile", "email"] with `issuer`, none with `endpoints`. */
  scopes?: string[];
  /** Claim that identifies the user at the provider. Default: "sub". */
  subjectClaim?: string;
  icon?: string;
  brand?: string;
  /**
   * Map ID token / userinfo claims to a Matrix account. Return a localpart and optional
   * display name, or null to refuse login. Default: sanitised `preferred_username`, then `sub`.
   */
  mapUser?: (
    claims: Record<string, any>,
  ) => { localpart: string; displayname?: string } | null | Promise<{ localpart: string; displayname?: string } | null>;
  /** Create accounts for unknown users. Default: true. */
  allowRegistration?: boolean;
}

export interface SsoOptions {
  providers: SsoProvider[];
  /**
   * Clients that receive the login token straight away, as URL prefixes such as
   * `"https://app.element.io/"` (same scheme and host, path starting with the prefix's path).
   * Other clients get a page naming them, where the user confirms before the token is sent.
   */
  clientAllowlist?: string[];
}

/**
 * What a login through a provider is for: a client of the legacy API (`m.login.sso`, which gets a
 * login token at `redirectUrl`), or the server's own web pages (OAuth 2.0 API), which continue
 * at `next` in the browser session `sid`.
 */
export type SsoTarget = { kind: "client"; redirectUrl: string } | { kind: "web"; next: string; sid: string };

/** Where the browser goes after login, and whether the user has to confirm that client first. */
export interface SsoResult {
  url: string;
  confirm: boolean;
  /** The client as shown to the user: its host, or its scheme for app links. */
  client: string;
}

// https://github.com/k18k/matrix-nodejs-homeserver/issues/19: schemes that run code or read data
// in the browser rather than open a client. App links (custom schemes) stay allowed.
const UNSAFE_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:", "about:"]);

/** The client's redirect URL, if it is one the server may send a login token to. */
export function checkRedirectUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return UNSAFE_SCHEMES.has(new URL(raw).protocol) ? null : raw;
  } catch {
    return null;
  }
}

function clientMatches(raw: string, entry: string): boolean {
  try {
    const url = new URL(raw);
    const allowed = new URL(entry);
    // Compared by parts, so that an entry "https://app.example" does not also admit
    // "https://app.example.evil.net".
    if (allowed.host) return url.protocol === allowed.protocol && url.host === allowed.host && url.pathname.startsWith(allowed.pathname);
    return raw.startsWith(entry);
  } catch {
    return false;
  }
}

const sameIssuer = (a: unknown, b: string) => typeof a === "string" && a.replace(/\/$/, "") === b.replace(/\/$/, "");

interface PendingLogin {
  providerId: string;
  target: SsoTarget;
  verifier: string;
  nonce: string;
  expires: number;
}

export function sanitizeLocalpart(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._=\-/+]/g, "_")
    .slice(0, 200);
}

function decodeJwtPayload(jwt: string): Record<string, any> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("Malformed ID token");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/**
 * GitHub as an identity provider (an OAuth app or GitHub app; its callback URL is
 * `{publicBaseUrl}/_matrix/client/v3/login/sso/callback/github`). Users are matched by their
 * numeric GitHub ID, so renaming the GitHub account keeps the Matrix account; new accounts take
 * the GitHub login as their localpart.
 */
export function githubProvider(opts: {
  clientId: string;
  clientSecret: string;
  id?: string;
  name?: string;
  allowRegistration?: boolean;
  mapUser?: SsoProvider["mapUser"];
}): SsoProvider {
  return {
    id: opts.id ?? "github",
    name: opts.name ?? "GitHub",
    brand: "github",
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    endpoints: {
      authorization: "https://github.com/login/oauth/authorize",
      token: "https://github.com/login/oauth/access_token",
      userinfo: "https://api.github.com/user",
    },
    scopes: ["read:user"],
    subjectClaim: "id",
    mapUser: opts.mapUser ?? ((c) => ({ localpart: sanitizeLocalpart(String(c.login ?? c.id)), displayname: c.name ?? c.login })),
    ...(opts.allowRegistration !== undefined ? { allowRegistration: opts.allowRegistration } : {}),
  };
}

// GitHub's API refuses requests without a User-Agent.
const USER_AGENT = "matrix-nodejs-homeserver";

/** Upstream login (authorization code + PKCE) for the legacy `m.login.sso` and the OAuth 2.0 API's web pages. */
export class SsoService {
  private hs: Homeserver;
  readonly providers: SsoProvider[];
  readonly clientAllowlist: string[];
  private discovery = new Map<string, Record<string, any>>();

  constructor(hs: Homeserver, options: SsoOptions) {
    this.hs = hs;
    this.providers = options.providers;
    this.clientAllowlist = options.clientAllowlist ?? [];
  }

  private callbackUrl(provider: SsoProvider): string {
    const base = this.hs.config.publicBaseUrl;
    if (!base) throw new Error("publicBaseUrl is required for SSO");
    return `${base.replace(/\/$/, "")}/_matrix/client/v3/login/sso/callback/${encodeURIComponent(provider.id)}`;
  }

  private async discover(provider: SsoProvider): Promise<Record<string, any>> {
    if (provider.endpoints) {
      const e = provider.endpoints;
      return { issuer: provider.issuer, authorization_endpoint: e.authorization, token_endpoint: e.token, userinfo_endpoint: e.userinfo };
    }
    const cached = this.discovery.get(provider.id);
    if (cached) return cached;
    if (!provider.issuer) throw new Error(`Identity provider ${provider.id} needs an issuer or endpoints`);
    const res = await this.hs.fetch(`${provider.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`OIDC discovery for ${provider.id} failed with ${res.status}`);
    const meta = (await res.json()) as Record<string, any>;
    // https://github.com/k18k/matrix-nodejs-homeserver/issues/19: OpenID Connect Discovery 4.3,
    // the document must be the configured issuer's. ID tokens are then checked against it.
    if (!sameIssuer(meta.issuer, provider.issuer!)) throw new Error(`OIDC discovery for ${provider.id} returned another issuer`);
    this.discovery.set(provider.id, meta);
    return meta;
  }

  private scopes(provider: SsoProvider): string[] {
    return provider.scopes ?? (provider.endpoints ? [] : ["openid", "profile", "email"]);
  }

  /** URL to send the user's browser to. */
  async startLogin(providerId: string | null, target: SsoTarget): Promise<string> {
    const provider = providerId ? this.providers.find((p) => p.id === providerId) : this.providers[0];
    if (!provider) throw errors.notFound("Unknown identity provider");
    const meta = await this.discover(provider);
    const state = randomToken(24);
    const verifier = urlSafeBase64(randomBytes(32));
    const nonce = randomToken(16);
    await this.hs.cluster.set(
      `sso:${state}`,
      { providerId: provider.id, target, verifier, nonce, expires: Date.now() + 10 * 60_000 } satisfies PendingLogin,
      10 * 60_000,
    );
    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", provider.clientId);
    url.searchParams.set("redirect_uri", this.callbackUrl(provider));
    const scopes = this.scopes(provider);
    if (scopes.length) url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", urlSafeBase64(createHash("sha256").update(verifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /** Handle the provider's redirect: the user who logged in, and what the login was for. */
  async finishLogin(providerId: string, params: URLSearchParams): Promise<{ userId: string; target: SsoTarget }> {
    const state = params.get("state") ?? "";
    const pending = await this.hs.cluster.get<PendingLogin>(`sso:${state}`);
    await this.hs.cluster.delete(`sso:${state}`);
    if (!pending || pending.expires < Date.now() || pending.providerId !== providerId)
      throw errors.forbidden("Unknown or expired login attempt");
    if (params.get("error")) throw errors.forbidden(`Login failed: ${params.get("error")}`);
    const code = params.get("code");
    if (!code) throw errors.missingParam("Missing code");
    const provider = this.providers.find((p) => p.id === providerId)!;
    const meta = await this.discover(provider);

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.callbackUrl(provider),
      code_verifier: pending.verifier,
      client_id: provider.clientId,
    });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": USER_AGENT,
    };
    if (provider.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(provider.clientId)}:${encodeURIComponent(provider.clientSecret)}`).toString("base64")}`;
    }
    const res = await this.hs.fetch(meta.token_endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw errors.forbidden("Code exchange failed");
    const tokens = (await res.json()) as Record<string, any>;
    // GitHub reports a failed exchange with status 200 and an `error` field.
    if (typeof tokens.error === "string") throw errors.forbidden("Code exchange failed");

    // The ID token comes straight from the token endpoint over TLS, so its issuer is
    // authenticated by the connection (OIDC Core 3.1.3.7); we still check the claims.
    let claims: Record<string, any> = {};
    // https://github.com/k18k/matrix-nodejs-homeserver/issues/19: with the openid scope the token
    // response must carry an ID token (OIDC Core 3.1.3.3); without one, its checks were skipped.
    const openid = this.scopes(provider).includes("openid");
    if (openid && typeof tokens.id_token !== "string") throw errors.forbidden("The provider returned no ID token");
    if (typeof tokens.id_token === "string") {
      claims = decodeJwtPayload(tokens.id_token);
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== meta.issuer || !aud.includes(provider.clientId)) throw errors.forbidden("ID token issuer or audience mismatch");
      if (claims.nonce !== pending.nonce) throw errors.forbidden("ID token nonce mismatch");
      if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) throw errors.forbidden("ID token expired");
    }
    if (meta.userinfo_endpoint && typeof tokens.access_token === "string") {
      const info = await this.hs.fetch(meta.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      if (info.ok) {
        const userinfo = (await info.json()) as Record<string, any>;
        if (claims.sub && userinfo.sub !== claims.sub) throw errors.forbidden("Userinfo subject mismatch");
        claims = { ...userinfo, ...claims };
      }
    }
    const rawSubject = claims[provider.subjectClaim ?? "sub"];
    // GitHub's user ID is a number.
    const subject = typeof rawSubject === "number" ? String(rawSubject) : rawSubject;
    if (typeof subject !== "string" || !subject) throw errors.forbidden("Provider did not return a subject");

    const userId = await this.resolveUser(provider, subject, claims);
    await this.hs.audit.record({ action: "sso_login", actor: userId, details: { idp: provider.id, subject } });
    return { userId, target: pending.target };
  }

  private async resolveUser(provider: SsoProvider, subject: string, claims: Record<string, any>): Promise<string> {
    const link = await this.hs.db.findOne("sso_identities", [
      { field: "idp_id", value: provider.id },
      { field: "subject", value: subject },
    ]);
    if (link) return link.user_id;
    if (provider.allowRegistration === false) throw errors.forbidden("No account is linked to this identity");
    const mapped = provider.mapUser
      ? await provider.mapUser(claims)
      : { localpart: sanitizeLocalpart(claims.preferred_username ?? subject), displayname: claims.name };
    if (!mapped || !LOCALPART_RE.test(mapped.localpart)) throw errors.forbidden("Could not map identity to a Matrix user");
    let localpart = mapped.localpart;
    // Avoid taking over existing accounts: pick a free localpart.
    for (let i = 1; await this.hs.db.findOne("users", [{ field: "user_id", value: `@${localpart}:${this.hs.serverName}` }]); i++) {
      localpart = `${mapped.localpart}${i}`;
    }
    const userId = await this.hs.admin.createUser(localpart, { displayname: mapped.displayname });
    await this.hs.db.create("sso_identities", { idp_id: provider.id, subject, user_id: userId });
    return userId;
  }
}

/**
 * The legacy API's last step: the client URL carrying a login token for `userId`, and whether
 * the user confirms the client first (clients not on `sso.clientAllowlist`).
 */
export async function legacyClientRedirect(hs: Homeserver, userId: string, redirectUrl: string): Promise<SsoResult> {
  const loginToken = await hs.auth.createLoginToken(userId);
  const redirect = new URL(redirectUrl);
  redirect.searchParams.set("loginToken", loginToken);
  // Security (https://github.com/k18k/matrix-nodejs-homeserver/issues/19): open redirect leaking
  // a credential, CWE-601. The token went to whatever redirectUrl the login started with, so a
  // crafted link could deliver a user's token to an attacker's site, who could then log in as
  // them. Unless the client is on the operator's allowlist, the user now confirms the client
  // on a page that names it.
  return {
    url: redirect.toString(),
    confirm: !(hs.sso?.clientAllowlist ?? []).some((entry) => clientMatches(redirectUrl, entry)),
    client: redirect.host || redirect.protocol.replace(/:$/, ""),
  };
}
