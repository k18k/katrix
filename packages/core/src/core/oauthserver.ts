import { createHash, randomInt, sign, timingSafeEqual } from "node:crypto";
import { randomToken, urlSafeBase64 } from "#core/crypto.ts";
import { canonicalJson } from "#core/json.ts";
import type { Homeserver } from "#homeserver.ts";

// The OAuth 2.0 API of the Matrix spec (v1.15, device grant and account management v1.18), served
// by the homeserver itself: dynamic client registration (RFC 7591), the authorization code grant
// with PKCE (RFC 7636), the device authorization grant (RFC 8628), the refresh token grant and
// token revocation (RFC 7009). Users log in on the server's own web pages (src/api/oauthserver.ts)
// with a password or through the upstream providers of the `sso` option (e.g. GitHub).
//
// Short-lived state (pending authorizations, codes, device codes, browser sessions, approvals) is
// kept in the cluster KV, so every instance can continue a flow another one started. Clients and
// tokens are in the database.

export interface OAuthServerOptions {
  /**
   * Keep the legacy login API (`/login`, `/register`) next to the OAuth 2.0 API. Its `m.login.sso`
   * flow then goes through the same web login and is marked `oauth_aware_preferred`. Default: true.
   */
  legacyApi?: boolean;
  /** Lifetime of access tokens issued through the OAuth 2.0 API, in ms. Default: 5 minutes. */
  accessTokenLifetimeMs?: number;
  /** Shown on the login and registration pages: the server's terms of service and privacy policy. */
  termsUrl?: string;
  policyUrl?: string;
  /** How long a browser stays logged in to the web pages, in ms. Default: 7 days. */
  webSessionLifetimeMs?: number;
}

/** Path prefix of every endpoint and page. Under `/_synapse/client`, which proxies already forward. */
export const OAUTH_PREFIX = "/_synapse/client/oauth2";

export const API_SCOPE = "urn:matrix:client:api:*";
const API_SCOPES = [API_SCOPE, "urn:matrix:org.matrix.msc2967.client:api:*"];
const DEVICE_SCOPE_PREFIXES = ["urn:matrix:client:device:", "urn:matrix:org.matrix.msc2967.client:device:"];

export const GRANT_CODE = "authorization_code";
export const GRANT_REFRESH = "refresh_token";
export const GRANT_DEVICE = "urn:ietf:params:oauth:grant-type:device_code";
const SUPPORTED_GRANTS = [GRANT_CODE, GRANT_REFRESH, GRANT_DEVICE];

export const ACCOUNT_ACTIONS = [
  "org.matrix.profile",
  "org.matrix.devices_list",
  "org.matrix.device_view",
  "org.matrix.device_delete",
  "org.matrix.account_deactivate",
  "org.matrix.cross_signing_reset",
] as const;

const GRANT_TTL_MS = 30 * 60_000;
const CODE_TTL_MS = 10 * 60_000;
const DEVICE_CODE_TTL_MS = 15 * 60_000;
const DEVICE_POLL_INTERVAL_S = 5;
/** How long an approved cross-signing reset may be used (Synapse/MAS use the same window). */
export const CROSS_SIGNING_RESET_WINDOW_MS = 10 * 60_000;
/** Registered clients without tokens are deleted after this long. */
const UNUSED_CLIENT_TTL_MS = 30 * 24 * 3600_000;

/** An OAuth error response (RFC 6749 section 5.2, RFC 7591 section 3.2.2). */
export class OAuthError extends Error {
  readonly error: string;
  readonly description: string;
  readonly status: number;

  constructor(error: string, description: string, status = 400) {
    super(description);
    this.error = error;
    this.description = description;
    this.status = status;
  }
}

export interface ClientMetadata {
  client_id: string;
  client_uri: string;
  client_name?: string;
  logo_uri?: string;
  tos_uri?: string;
  policy_uri?: string;
  redirect_uris: string[];
  response_types: string[];
  grant_types: string[];
  token_endpoint_auth_method: "none";
  application_type: "web" | "native";
}

/** A validated authorization request, waiting for the user to log in and consent. */
export interface PendingGrant {
  clientId: string;
  redirectUri: string;
  responseMode: "query" | "fragment";
  state?: string;
  scope: string;
  deviceId: string;
  codeChallenge: string;
  nonce?: string;
  /** The client asked for the registration page (`prompt=create`). */
  create: boolean;
}

interface IssuedCode extends PendingGrant {
  userId: string;
  authTime: number;
}

export interface DeviceGrant {
  clientId: string;
  scope: string;
  deviceId: string;
  userCode: string;
  status: "pending" | "approved" | "denied";
  userId?: string;
  lastPoll: number;
  expires: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
  id_token?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** RFC 6749 section 3.3: the characters a scope token may use. */
const SCOPE_TOKEN_RE = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
/** Device IDs end up in URLs and keys: the unreserved characters of RFC 3986 only. */
const DEVICE_ID_RE = /^[A-Za-z0-9._~-]{1,255}$/;
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

const isHostUnder = (host: string, base: string) => host === base || host.endsWith(`.${base}`);

function parseUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** An `https` URL without credentials, on the client's host or a subdomain of it. */
function checkHttpsUri(field: string, raw: unknown, clientHost: string | null): string {
  const url = parseUrl(raw);
  if (!url || url.protocol !== "https:" || url.username || url.password)
    throw new OAuthError("invalid_client_metadata", `${field} must be an https URL without credentials`);
  if (clientHost !== null && !isHostUnder(url.hostname, clientHost))
    throw new OAuthError("invalid_client_metadata", `${field} must be on the host of client_uri or a subdomain of it`);
  return raw as string;
}

/** Redirect URI validation of the spec ("Redirect URI validation", after RFC 8252 section 7). */
export function checkRedirectUri(raw: string, applicationType: "web" | "native", clientHost: string): void {
  const bad = (why: string): never => {
    throw new OAuthError("invalid_redirect_uri", `Invalid redirect URI ${raw}: ${why}`);
  };
  if (raw.includes("#")) bad("it may not have a fragment");
  const url = parseUrl(raw) ?? bad("not a URL");
  if (url.protocol === "https:") {
    if (url.username || url.password) bad("it may not contain credentials");
    if (!isHostUnder(url.hostname, clientHost)) bad("it must be on the host of client_uri or a subdomain of it");
    return;
  }
  if (applicationType !== "native") bad("web clients must use https");
  if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname)) bad("http is only allowed on the loopback interface");
    if (url.port) bad("loopback redirect URIs are registered without a port");
    return;
  }
  // A private-use scheme: the reverse of the client's host (or a name under it), no authority.
  const scheme = url.protocol.slice(0, -1);
  const reversed = clientHost.split(".").reverse().join(".");
  if (scheme !== reversed && !scheme.startsWith(`${reversed}.`)) bad(`the scheme must start with ${reversed}`);
  if (raw.slice(url.protocol.length).startsWith("//")) bad("a private-use scheme may not have an authority");
}

/** Whether `given` is one of the client's redirect URIs; loopback URIs match on any port. */
export function redirectUriMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  const url = parseUrl(given);
  if (!url || url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || !url.port) return false;
  url.port = "";
  return registered.includes(url.toString()) || registered.includes(url.toString().replace(/\/$/, ""));
}

/** Validate a registration request and return the metadata as registered (RFC 7591 section 2). */
export function validateClientMetadata(raw: Record<string, unknown>): Omit<ClientMetadata, "client_id"> {
  const clientUri = checkHttpsUri("client_uri", raw.client_uri, null);
  const host = new URL(clientUri).hostname;
  const applicationType = raw.application_type ?? "web";
  if (applicationType !== "web" && applicationType !== "native")
    throw new OAuthError("invalid_client_metadata", "application_type must be web or native");
  const list = (field: string, fallback: string[]): string[] => {
    const v = raw[field];
    if (v === undefined) return fallback;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
      throw new OAuthError("invalid_client_metadata", `${field} must be a list of strings`);
    return v as string[];
  };
  // Values the server does not understand are ignored (the spec's client metadata).
  const grantTypes = list("grant_types", [GRANT_CODE]).filter((g) => SUPPORTED_GRANTS.includes(g));
  const responseTypes = list("response_types", ["code"]).filter((t) => t === "code");
  const redirectUris = list("redirect_uris", []);
  if (grantTypes.includes(GRANT_CODE) && (redirectUris.length === 0 || responseTypes.length === 0))
    throw new OAuthError("invalid_client_metadata", "The authorization code grant needs redirect_uris and the code response type");
  if (grantTypes.length === 0) throw new OAuthError("invalid_client_metadata", "No supported grant type");
  for (const uri of redirectUris) checkRedirectUri(uri, applicationType, host);
  // Matrix clients are public clients: the spec requires `none`, and it is the only method here.
  const authMethod = raw.token_endpoint_auth_method ?? "none";
  if (authMethod !== "none") throw new OAuthError("invalid_client_metadata", "Only token_endpoint_auth_method none is supported");
  const out: Omit<ClientMetadata, "client_id"> = {
    client_uri: clientUri,
    redirect_uris: redirectUris,
    response_types: responseTypes,
    grant_types: grantTypes,
    token_endpoint_auth_method: "none",
    application_type: applicationType,
  };
  if (raw.client_name !== undefined) {
    if (typeof raw.client_name !== "string") throw new OAuthError("invalid_client_metadata", "client_name must be a string");
    out.client_name = raw.client_name.slice(0, 200);
  }
  // Localized values (`client_name#fr`) are not registered, which the spec allows.
  for (const field of ["logo_uri", "tos_uri", "policy_uri"] as const)
    if (raw[field] !== undefined) out[field] = checkHttpsUri(field, raw[field], host);
  return out;
}

/** The API scope and the one device ID a login scope must contain. */
export function parseScope(scope: string | null): { scope: string; deviceId: string; openid: boolean } {
  const tokens = (scope ?? "").split(" ").filter(Boolean);
  if (!tokens.some((t) => API_SCOPES.includes(t))) throw new OAuthError("invalid_scope", `The scope must include ${API_SCOPE}`);
  const devices: string[] = [];
  let openid = false;
  for (const t of tokens) {
    if (!SCOPE_TOKEN_RE.test(t)) throw new OAuthError("invalid_scope", "Invalid scope token");
    const prefix = DEVICE_SCOPE_PREFIXES.find((p) => t.startsWith(p));
    if (prefix) devices.push(t.slice(prefix.length));
    else if (t === "openid") openid = true;
    else if (!API_SCOPES.includes(t)) throw new OAuthError("invalid_scope", `Unknown scope token ${t}`);
  }
  if (devices.length !== 1) throw new OAuthError("invalid_scope", "The scope must include exactly one device ID");
  if (!DEVICE_ID_RE.test(devices[0])) throw new OAuthError("invalid_scope", "Device IDs may only use letters, digits and - . _ ~");
  return { scope: tokens.join(" "), deviceId: devices[0], openid };
}

const s256 = (verifier: string) => urlSafeBase64(createHash("sha256").update(verifier).digest());

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class OAuthServer {
  private hs: Homeserver;
  readonly options: OAuthServerOptions;
  /** The issuer identifier: the public base URL with a trailing slash. */
  readonly issuer: string;

  constructor(hs: Homeserver, options: OAuthServerOptions, publicBaseUrl: string) {
    this.hs = hs;
    this.options = options;
    this.issuer = `${publicBaseUrl.replace(/\/$/, "")}/`;
  }

  get legacyApi(): boolean {
    return this.options.legacyApi !== false;
  }

  get accessTokenLifetimeMs(): number {
    return this.options.accessTokenLifetimeMs ?? 5 * 60_000;
  }

  /** Absolute URL of a path under the OAuth prefix. */
  url(path: string): string {
    return `${this.issuer}${OAUTH_PREFIX.slice(1)}${path}`;
  }

  get accountManagementUri(): string {
    return this.url("/account");
  }

  /** Authorization server metadata (RFC 8414), served at `/_matrix/client/v1/auth_metadata`. */
  metadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: this.url("/authorize"),
      token_endpoint: this.url("/token"),
      registration_endpoint: this.url("/register"),
      revocation_endpoint: this.url("/revoke"),
      device_authorization_endpoint: this.url("/device"),
      userinfo_endpoint: this.url("/userinfo"),
      jwks_uri: this.url("/keys.json"),
      response_types_supported: ["code"],
      response_modes_supported: ["query", "fragment"],
      grant_types_supported: SUPPORTED_GRANTS,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [API_SCOPE, "urn:matrix:client:device:*", "openid"],
      // Some clients (matrix-js-sdk) ask for `openid` and read the ID token's claims.
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["EdDSA"],
      claims_supported: ["iss", "sub", "aud", "exp", "iat", "auth_time", "nonce"],
      prompt_values_supported: ["create"],
      authorization_response_iss_parameter_supported: true,
      account_management_uri: this.accountManagementUri,
      account_management_actions_supported: ACCOUNT_ACTIONS,
      ...(this.options.termsUrl ? { op_tos_uri: this.options.termsUrl } : {}),
      ...(this.options.policyUrl ? { op_policy_uri: this.options.policyUrl } : {}),
    };
  }

  /** The server's signing key as a JWK set (RFC 8037), for ID tokens. */
  jwks(): { keys: Record<string, string>[] } {
    const key = this.hs.signingKey;
    const x = Buffer.from(key.publicKeyBase64, "base64").toString("base64url");
    return { keys: [{ kty: "OKP", crv: "Ed25519", x, kid: key.keyId, alg: "EdDSA", use: "sig" }] };
  }

  // --- Clients ------------------------------------------------------------------

  /**
   * Register a client. Each login registers again (the spec asks clients to), so identical
   * metadata gets the same client ID, derived from it, instead of a new row every time.
   */
  async registerClient(raw: Record<string, unknown>): Promise<ClientMetadata> {
    const metadata = validateClientMetadata(raw);
    const clientId = urlSafeBase64(createHash("sha256").update(canonicalJson(metadata)).digest()).slice(0, 26);
    const client: ClientMetadata = { client_id: clientId, ...metadata };
    if (!(await this.hs.db.findOne("oauth_clients", [{ field: "client_id", value: clientId }])))
      await this.hs.db.upsert("oauth_clients", { client_id: clientId, metadata: client, created_ts: Date.now() });
    return client;
  }

  async client(clientId: string | null): Promise<ClientMetadata | null> {
    if (!clientId) return null;
    const row = await this.hs.db.findOne("oauth_clients", [{ field: "client_id", value: clientId }]);
    return row ? (row.metadata as ClientMetadata) : null;
  }

  /** Delete old registrations that no token uses (the spec forbids deleting ones in use). */
  async prune(): Promise<void> {
    const old = await this.hs.db.findMany("oauth_clients", {
      where: [{ field: "created_ts", operator: "lt", value: Date.now() - UNUSED_CLIENT_TTL_MS }],
      limit: 500,
    });
    for (const c of old) {
      const used = await this.hs.db.findMany("access_tokens", { where: [{ field: "client_id", value: c.client_id }], limit: 1 });
      if (used.length === 0) await this.hs.db.delete("oauth_clients", [{ field: "client_id", value: c.client_id }]);
    }
  }

  // --- Authorization code grant -----------------------------------------------

  /**
   * Check an authorization request. Problems with the client or the redirect URI are thrown as
   * `OAuthError` with `redirect: false` semantics (shown to the user: RFC 6749 section 4.1.2.1
   * forbids redirecting to an unverified URI); the rest come back as `{ error }` to redirect.
   */
  async checkAuthorizationRequest(
    params: URLSearchParams,
  ): Promise<{ client: ClientMetadata; grant: PendingGrant } | { client: ClientMetadata; redirect: string; error: OAuthError }> {
    const client = await this.client(params.get("client_id"));
    if (!client) throw new OAuthError("invalid_client", "Unknown client");
    const redirectUri = params.get("redirect_uri");
    if (!redirectUri || !redirectUriMatches(client.redirect_uris, redirectUri))
      throw new OAuthError("invalid_request", "The redirect URI is not registered for this client");
    const responseMode = params.get("response_mode") ?? "query";
    const state = params.get("state") ?? undefined;
    const fail = (error: string, description: string) => ({
      client,
      redirect: this.callbackUrl(redirectUri, responseMode === "fragment" ? "fragment" : "query", {
        error,
        error_description: description,
        state,
      }),
      error: new OAuthError(error, description),
    });
    if (responseMode !== "query" && responseMode !== "fragment") return fail("invalid_request", "Unsupported response_mode");
    if (params.get("response_type") !== "code") return fail("unsupported_response_type", "Only the code response type is supported");
    if (!client.grant_types.includes(GRANT_CODE))
      return fail("unauthorized_client", "The client did not register the authorization code grant");
    const challenge = params.get("code_challenge");
    if (!challenge || params.get("code_challenge_method") !== "S256")
      return fail("invalid_request", "PKCE with the S256 method is required");
    let scope: ReturnType<typeof parseScope>;
    try {
      scope = parseScope(params.get("scope"));
    } catch (err) {
      if (err instanceof OAuthError) return fail(err.error, err.description);
      throw err;
    }
    const prompt = (params.get("prompt") ?? "").split(" ").filter(Boolean);
    // The pages always ask for consent, so a request that allows no interaction cannot succeed.
    if (prompt.includes("none")) return fail("interaction_required", "The user has to approve the client");
    return {
      client,
      grant: {
        clientId: client.client_id,
        redirectUri,
        responseMode,
        ...(state !== undefined ? { state } : {}),
        scope: scope.scope,
        deviceId: scope.deviceId,
        codeChallenge: challenge,
        ...(params.get("nonce") ? { nonce: params.get("nonce")! } : {}),
        create: prompt.includes("create"),
      },
    };
  }

  /** The client's redirect URI with the response parameters (and RFC 9207 `iss`). */
  callbackUrl(redirectUri: string, mode: "query" | "fragment", params: Record<string, string | undefined>): string {
    const url = new URL(redirectUri);
    const out = new URLSearchParams(mode === "query" ? url.search : "");
    for (const [k, v] of Object.entries({ ...params, iss: this.issuer })) if (v !== undefined) out.set(k, v);
    if (mode === "query") url.search = out.toString();
    else url.hash = out.toString();
    return url.toString();
  }

  async saveGrant(grant: PendingGrant): Promise<string> {
    const id = randomToken(24);
    await this.hs.cluster.set(`oauth:grant:${id}`, grant, GRANT_TTL_MS);
    return id;
  }

  grant(id: string): Promise<PendingGrant | null> {
    return this.hs.cluster.get<PendingGrant>(`oauth:grant:${id}`);
  }

  /** The user approved: issue a code and return where the browser goes next. */
  async approveGrant(id: string, grant: PendingGrant, userId: string, authTime: number): Promise<string> {
    await this.hs.cluster.delete(`oauth:grant:${id}`);
    const code = randomToken(32);
    await this.hs.cluster.set(`oauth:code:${code}`, { ...grant, userId, authTime } satisfies IssuedCode, CODE_TTL_MS);
    return this.callbackUrl(grant.redirectUri, grant.responseMode, { code, state: grant.state });
  }

  async denyGrant(id: string, grant: PendingGrant): Promise<string> {
    await this.hs.cluster.delete(`oauth:grant:${id}`);
    return this.callbackUrl(grant.redirectUri, grant.responseMode, {
      error: "access_denied",
      error_description: "The user denied access",
      state: grant.state,
    });
  }

  // --- Token endpoint -----------------------------------------------------------

  async token(params: URLSearchParams, clientId: string | null): Promise<TokenResponse> {
    const client = await this.client(clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
    const grantType = params.get("grant_type");
    if (!grantType || !SUPPORTED_GRANTS.includes(grantType)) throw new OAuthError("unsupported_grant_type", "Unsupported grant type");
    if (!client.grant_types.includes(grantType)) throw new OAuthError("unauthorized_client", "The client did not register this grant type");
    if (grantType === GRANT_CODE) return this.exchangeCode(client, params);
    if (grantType === GRANT_DEVICE) return this.pollDevice(client, params.get("device_code"));
    const refreshToken = params.get("refresh_token");
    if (!refreshToken) throw new OAuthError("invalid_request", "Missing refresh_token");
    let out;
    try {
      out = await this.hs.auth.refresh(refreshToken, { clientId: client.client_id, lifetimeMs: this.accessTokenLifetimeMs });
    } catch {
      throw new OAuthError("invalid_grant", "The refresh token is invalid, expired or already used");
    }
    return this.tokenResponse(out, out.scope ?? `${API_SCOPE} urn:matrix:client:device:${out.device_id}`);
  }

  private async exchangeCode(client: ClientMetadata, params: URLSearchParams): Promise<TokenResponse> {
    const code = params.get("code");
    if (!code) throw new OAuthError("invalid_request", "Missing code");
    const issued = await this.hs.cluster.lock(`oauth:code:${code}`, async () => {
      const found = await this.hs.cluster.get<IssuedCode>(`oauth:code:${code}`);
      if (found) {
        await this.hs.cluster.delete(`oauth:code:${code}`);
        return found;
      }
      // RFC 6749 section 4.1.2: a code used twice may have been stolen, so the tokens issued for
      // it are revoked.
      const used = await this.hs.cluster.get<{ userId: string; deviceId: string }>(`oauth:usedcode:${code}`);
      if (used) {
        this.hs.logger.warn("An authorization code was used twice; logging out", used.userId, used.deviceId);
        await this.hs.auth.revokeDeviceTokens(used.userId, used.deviceId);
      }
      return null;
    });
    if (!issued) throw new OAuthError("invalid_grant", "Unknown, expired or used code");
    if (issued.clientId !== client.client_id) throw new OAuthError("invalid_grant", "The code was issued to another client");
    if (params.get("redirect_uri") !== issued.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match");
    const verifier = params.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(s256(verifier), issued.codeChallenge))
      throw new OAuthError("invalid_grant", "PKCE verification failed");
    await this.hs.cluster.set(`oauth:usedcode:${code}`, { userId: issued.userId, deviceId: issued.deviceId }, CODE_TTL_MS);
    const out = await this.issue(client, issued.userId, issued.deviceId, issued.scope);
    const response = this.tokenResponse(out, issued.scope);
    if (issued.scope.split(" ").includes("openid")) response.id_token = this.idToken(client, issued.userId, issued.authTime, issued.nonce);
    return response;
  }

  private async issue(client: ClientMetadata, userId: string, deviceId: string, scope: string) {
    const user = await this.hs.db.findOne("users", [{ field: "user_id", value: userId }]);
    if (!user || user.deactivated) throw new OAuthError("invalid_grant", "The account is deactivated");
    if (user.locked) throw new OAuthError("invalid_grant", "The account is locked");
    const out = await this.hs.auth.createSession(userId, {
      deviceId,
      displayName: client.client_name,
      refreshToken: true,
      clientId: client.client_id,
      lifetimeMs: this.accessTokenLifetimeMs,
      scope,
    });
    await this.hs.audit.record({ action: "oauth_login", actor: userId, target: deviceId, details: { client_id: client.client_id } });
    return out;
  }

  private tokenResponse(out: { access_token: string; refresh_token?: string }, scope: string): TokenResponse {
    return {
      access_token: out.access_token,
      token_type: "Bearer",
      expires_in: Math.round(this.accessTokenLifetimeMs / 1000),
      refresh_token: out.refresh_token!,
      scope,
    };
  }

  /** An OpenID Connect ID token (EdDSA with the server's signing key). */
  private idToken(client: ClientMetadata, userId: string, authTime: number, nonce?: string): string {
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const header = enc({ alg: "EdDSA", typ: "JWT", kid: this.hs.signingKey.keyId });
    const payload = enc({
      iss: this.issuer,
      sub: userId,
      aud: client.client_id,
      iat: now,
      exp: now + 3600,
      auth_time: Math.floor(authTime / 1000),
      ...(nonce ? { nonce } : {}),
    });
    const signature = sign(null, Buffer.from(`${header}.${payload}`), this.hs.signingKey.privateKey).toString("base64url");
    return `${header}.${payload}.${signature}`;
  }

  // --- Device authorization grant ----------------------------------------------

  async startDeviceGrant(clientId: string | null, scope: string | null) {
    const client = await this.client(clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
    if (!client.grant_types.includes(GRANT_DEVICE))
      throw new OAuthError("unauthorized_client", "The client did not register the device grant");
    const parsed = parseScope(scope);
    const deviceCode = randomToken(32);
    let userCode = "";
    for (let i = 0; i < 8; i++) userCode += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
    userCode = `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
    const grant: DeviceGrant = {
      clientId: client.client_id,
      scope: parsed.scope,
      deviceId: parsed.deviceId,
      userCode,
      status: "pending",
      lastPoll: 0,
      expires: Date.now() + DEVICE_CODE_TTL_MS,
    };
    await this.hs.cluster.set(`oauth:device:${deviceCode}`, grant, DEVICE_CODE_TTL_MS);
    await this.hs.cluster.set(`oauth:usercode:${userCode}`, deviceCode, DEVICE_CODE_TTL_MS);
    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: this.url("/link"),
      verification_uri_complete: `${this.url("/link")}?code=${userCode}`,
      expires_in: DEVICE_CODE_TTL_MS / 1000,
      interval: DEVICE_POLL_INTERVAL_S,
    };
  }

  /** The device grant a user code belongs to (typed in any case, with or without the dash). */
  async deviceGrantByUserCode(raw: string): Promise<{ deviceCode: string; grant: DeviceGrant } | null> {
    const clean = raw.toUpperCase().replace(/[^A-Z]/g, "");
    if (clean.length !== 8) return null;
    const userCode = `${clean.slice(0, 4)}-${clean.slice(4)}`;
    const deviceCode = await this.hs.cluster.get<string>(`oauth:usercode:${userCode}`);
    const grant = deviceCode ? await this.hs.cluster.get<DeviceGrant>(`oauth:device:${deviceCode}`) : null;
    return deviceCode && grant && grant.status === "pending" ? { deviceCode, grant } : null;
  }

  async decideDeviceGrant(deviceCode: string, grant: DeviceGrant, userId: string, approve: boolean): Promise<void> {
    await this.hs.cluster.delete(`oauth:usercode:${grant.userCode}`);
    const ttl = Math.max(1000, grant.expires - Date.now());
    await this.hs.cluster.set(`oauth:device:${deviceCode}`, { ...grant, status: approve ? "approved" : "denied", userId }, ttl);
  }

  private async pollDevice(client: ClientMetadata, deviceCode: string | null): Promise<TokenResponse> {
    if (!deviceCode) throw new OAuthError("invalid_request", "Missing device_code");
    const key = `oauth:device:${deviceCode}`;
    return this.hs.cluster.lock(key, async () => {
      const grant = await this.hs.cluster.get<DeviceGrant>(key);
      if (!grant) throw new OAuthError("expired_token", "The device code expired");
      if (grant.clientId !== client.client_id) throw new OAuthError("invalid_grant", "The device code was issued to another client");
      if (grant.status === "denied") {
        await this.hs.cluster.delete(key);
        throw new OAuthError("access_denied", "The user denied access");
      }
      if (grant.status === "pending") {
        const now = Date.now();
        const tooSoon = now - grant.lastPoll < DEVICE_POLL_INTERVAL_S * 1000 - 500;
        await this.hs.cluster.set(key, { ...grant, lastPoll: now }, Math.max(1000, grant.expires - now));
        throw new OAuthError(tooSoon ? "slow_down" : "authorization_pending", tooSoon ? "Polling too often" : "Waiting for the user");
      }
      await this.hs.cluster.delete(key);
      const out = await this.issue(client, grant.userId!, grant.deviceId, grant.scope);
      return this.tokenResponse(out, grant.scope);
    });
  }

  // --- Revocation -------------------------------------------------------------

  /**
   * Revoke an access or refresh token (RFC 7009). The spec revokes both tokens of the pair; a
   * logout through this endpoint ends the device's session like `/logout` does. Unknown tokens
   * are not an error.
   */
  async revoke(token: string | null): Promise<void> {
    if (!token) throw new OAuthError("invalid_request", "Missing token");
    const row =
      (await this.hs.db.findOne("access_tokens", [{ field: "token", value: token }])) ??
      (await this.hs.db.findOne("access_tokens", [{ field: "refresh_token", value: token }]));
    if (!row) return;
    await this.hs.auth.deleteDevice(row.user_id, row.device_id);
    await this.hs.audit.record({ action: "logout", actor: row.user_id, target: row.device_id, details: { revoked: true } });
  }
}

// https://github.com/k18k/matrix-nodejs-homeserver/issues/65: approvals for the m.oauth UIA stage.
// The user approves replacing their cross-signing keys on the account page (or, with delegated
// OAuth, the authorization server reports it through the admin API, as MAS does with Synapse);
// the stage only completes within the window after that.

/** Approve a cross-signing reset for `userId`; returns when the approval runs out. */
export async function allowCrossSigningReset(hs: Homeserver, userId: string): Promise<number> {
  const until = Date.now() + CROSS_SIGNING_RESET_WINDOW_MS;
  await hs.cluster.set(`xsign-reset:${userId}`, until, CROSS_SIGNING_RESET_WINDOW_MS);
  return until;
}

/**
 * Whether the user approved a cross-signing reset in the last few minutes. The approval is not
 * used up: a client may need several uploads (Synapse allows the same within the window).
 */
export async function crossSigningResetAllowed(hs: Homeserver, userId: string): Promise<boolean> {
  const until = await hs.cluster.get<number>(`xsign-reset:${userId}`);
  return !!until && until > Date.now();
}
