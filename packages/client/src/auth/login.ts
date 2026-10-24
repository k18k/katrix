import type { HttpAdapter } from "../http/adapter.ts";
import { MatrixHttpApi } from "../http/api.ts";
import { MatrixError } from "../http/errors.ts";
import { encodeQuery } from "../util/query.ts";
import type { Logger } from "../util/logger.ts";
import { Mutex } from "../util/mutex.ts";
import { refreshOAuthToken } from "./oauth.ts";
import type { Credentials, CredentialsStore, TokenProvider } from "./types.ts";

export interface LoginOptions {
  deviceId?: string;
  initialDeviceDisplayName?: string;
  /** Ask for a refresh token (default true); servers that do not issue them ignore it. */
  refreshToken?: boolean;
}

export type UserIdentifier =
  | { type: "m.id.user"; user: string }
  | { type: "m.id.thirdparty"; medium: string; address: string }
  | { type: "m.id.phone"; country: string; phone: string };

function credentialsFrom(res: Record<string, any>): Credentials {
  if (typeof res.user_id !== "string" || typeof res.access_token !== "string" || typeof res.device_id !== "string") {
    throw new Error("Login response is missing user_id, device_id or access_token");
  }
  return {
    userId: res.user_id,
    deviceId: res.device_id,
    accessToken: res.access_token,
    refreshToken: typeof res.refresh_token === "string" ? res.refresh_token : undefined,
    expiresAt: typeof res.expires_in_ms === "number" ? Date.now() + res.expires_in_ms : undefined,
    refresh: typeof res.refresh_token === "string" ? { kind: "matrix" } : undefined,
  };
}

/** Login API calls that need no access token (https://spec.matrix.org/v1.16/client-server-api/#login). */
export class Auth {
  private readonly api: MatrixHttpApi;

  constructor(opts: { baseUrl: string; http: HttpAdapter; logger?: Logger }) {
    this.api = new MatrixHttpApi({ ...opts });
  }

  /** The login types the server offers (GET /v3/login). */
  async loginFlows(): Promise<Array<{ type: string; [k: string]: unknown }>> {
    const res = await this.api.request<{ flows?: Array<{ type: string }> }>("GET", "/v3/login", { auth: false });
    return res.flows ?? [];
  }

  /** `user` is a localpart or a full user ID, or a full identifier for a third-party ID. */
  loginWithPassword(user: string | UserIdentifier, password: string, opts: LoginOptions = {}): Promise<Credentials> {
    const identifier = typeof user === "string" ? { type: "m.id.user", user } : user;
    return this.login({ type: "m.login.password", identifier, password }, opts);
  }

  /** The token an SSO redirect returns (m.login.token). */
  loginWithToken(token: string, opts: LoginOptions = {}): Promise<Credentials> {
    return this.login({ type: "m.login.token", token }, opts);
  }

  /**
   * Register an account (https://spec.matrix.org/v1.16/client-server-api/#post_matrixclientv3register).
   * Completes user-interactive authentication when the server offers a flow of stages this
   * method can do on its own (m.login.dummy, or none); other flows (CAPTCHA, email, terms) are
   * thrown as the server's 401 MatrixError, whose `data` holds the flows and session.
   */
  async register(username: string, password: string, opts: LoginOptions = {}): Promise<Credentials> {
    const body = {
      username,
      password,
      device_id: opts.deviceId,
      initial_device_display_name: opts.initialDeviceDisplayName,
      refresh_token: opts.refreshToken ?? true,
    };
    try {
      return credentialsFrom(await this.api.request("POST", "/v3/register", { auth: false, retryRateLimited: false, body }));
    } catch (e) {
      if (!(e instanceof MatrixError) || e.status !== 401 || !Array.isArray(e.data.flows)) throw e;
      const flows = e.data.flows as Array<{ stages?: string[] }>;
      if (!flows.some((f) => (f.stages ?? []).every((s) => s === "m.login.dummy"))) throw e;
      const auth = { type: "m.login.dummy", session: e.data.session };
      return credentialsFrom(
        await this.api.request("POST", "/v3/register", { auth: false, retryRateLimited: false, body: { ...body, auth } }),
      );
    }
  }

  /** The SSO redirect URL to open in a browser (https://spec.matrix.org/v1.16/client-server-api/#client-login-via-sso). */
  ssoRedirectUrl(redirectUrl: string, idpId?: string): string {
    const base = `${this.api.baseUrl}/_matrix/client/v3/login/sso/redirect`;
    return `${base}${idpId ? `/${encodeURIComponent(idpId)}` : ""}?${encodeQuery({ redirectUrl })}`;
  }

  private async login(body: Record<string, unknown>, opts: LoginOptions): Promise<Credentials> {
    const res = await this.api.request("POST", "/v3/login", {
      auth: false,
      // Not retried on its own: a password login is not idempotent for rate-limit accounting.
      retryRateLimited: false,
      body: {
        ...body,
        device_id: opts.deviceId,
        initial_device_display_name: opts.initialDeviceDisplayName,
        refresh_token: opts.refreshToken ?? true,
      },
    });
    return credentialsFrom(res);
  }

  /** The base URL from /.well-known/matrix/client, checked against /versions (spec "Server Discovery"). */
  static async discover(serverName: string, http: HttpAdapter): Promise<string> {
    const wellKnown = new MatrixHttpApi({ baseUrl: `https://${serverName}`, http });
    let baseUrl = `https://${serverName}`;
    try {
      const res = await wellKnown.request<{ "m.homeserver"?: { base_url?: string } }>("GET", "/.well-known/matrix/client", {
        auth: false,
        prefix: "",
      });
      const url = res["m.homeserver"]?.base_url;
      if (typeof url !== "string" || !/^https?:\/\/[^/]+/.test(url)) throw new Error("FAIL_PROMPT: invalid m.homeserver.base_url");
      baseUrl = url.replace(/\/+$/, "");
    } catch (e) {
      // A missing well-known (404) means: try the server name itself. Anything else is FAIL_PROMPT.
      if (!(e instanceof MatrixError && e.status === 404)) throw e;
    }
    const versions = await new MatrixHttpApi({ baseUrl, http }).request<{ versions?: string[] }>("GET", "/versions", { auth: false });
    if (!Array.isArray(versions.versions)) throw new Error("FAIL_ERROR: not a Matrix homeserver");
    return baseUrl;
  }
}

/**
 * Tokens from a login, refreshed with the refresh token when the server rejects the access token.
 * Concurrent requests that all see the expired token share one refresh.
 */
export class CredentialsTokenProvider implements TokenProvider {
  private credentials: Credentials;
  private readonly http: HttpAdapter;
  private readonly baseUrl: string;
  private readonly store?: CredentialsStore;
  private readonly mutex = new Mutex();

  constructor(opts: { credentials: Credentials; baseUrl: string; http: HttpAdapter; store?: CredentialsStore }) {
    this.credentials = opts.credentials;
    this.http = opts.http;
    this.baseUrl = opts.baseUrl;
    this.store = opts.store;
  }

  current(): Credentials {
    return this.credentials;
  }

  accessToken(): string {
    return this.credentials.accessToken;
  }

  refresh(): Promise<boolean> {
    const before = this.credentials.accessToken;
    return this.mutex.run(async () => {
      // Someone else refreshed while we waited.
      if (this.credentials.accessToken !== before) return true;
      const c = this.credentials;
      if (!c.refreshToken || !c.refresh) return false;
      try {
        let res: Record<string, any>;
        if (c.refresh.kind === "matrix") {
          res = await new MatrixHttpApi({ baseUrl: this.baseUrl, http: this.http }).request("POST", "/v3/refresh", {
            auth: false,
            body: { refresh_token: c.refreshToken },
          });
          this.credentials = {
            ...c,
            accessToken: res.access_token,
            refreshToken: res.refresh_token ?? c.refreshToken,
            expiresAt: typeof res.expires_in_ms === "number" ? Date.now() + res.expires_in_ms : undefined,
          };
        } else {
          const t = await refreshOAuthToken(this.http, c.refresh.tokenEndpoint, c.refresh.clientId, c.refreshToken);
          this.credentials = { ...c, accessToken: t.accessToken, refreshToken: t.refreshToken ?? c.refreshToken, expiresAt: t.expiresAt };
        }
      } catch (e) {
        // An invalid refresh token ends the session; network errors are thrown to the caller.
        if (e instanceof MatrixError && (e.status === 401 || e.status === 400 || e.status === 403)) return false;
        throw e;
      }
      await this.store?.onTokensRefreshed?.(this.credentials);
      return true;
    });
  }
}
