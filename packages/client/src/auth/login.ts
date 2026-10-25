import type { HttpAdapter } from "../http/adapter.ts";
import { MatrixHttpApi } from "../http/api.ts";
import { MatrixError } from "../http/errors.ts";
import type { Logger } from "../util/logger.ts";
import { Mutex } from "../util/mutex.ts";
import { refreshOAuthToken } from "./oauth.ts";
import type { Credentials, CredentialsStore, TokenProvider } from "./types.ts";
import { dummyAuth, withUserInteractiveAuth, type UiaCallback } from "./uia.ts";
import type {
  LoginFlow,
  LoginRequest,
  RequestTokenResponse,
  VersionsResponse,
  WellKnownSupport,
  LoginResponse,
  RefreshResponse,
  RegisterRequest,
  RegisterResponse,
  UserIdentifier,
  WellKnownClient,
} from "@katrix/shared";

export interface LoginOptions {
  deviceId?: string;
  initialDeviceDisplayName?: string;
  /** Ask for a refresh token (default true); servers that do not issue them ignore it. */
  refreshToken?: boolean;
}

function credentialsFrom(res: LoginResponse | RegisterResponse): Credentials {
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
  private readonly http: HttpAdapter;

  constructor(opts: { baseUrl: string; http: HttpAdapter; logger?: Logger }) {
    this.api = new MatrixHttpApi({ ...opts });
    this.http = opts.http;
  }

  /** The login types the server offers (GET /v3/login), with SSO identity providers. */
  async loginFlows(): Promise<LoginFlow[]> {
    const res = await this.api.endpoint("GET /v3/login", {}, { auth: false });
    return res.flows ?? [];
  }

  /** `user` is a localpart or a full user ID, or a full identifier for a third-party ID. */
  loginWithPassword(user: string | UserIdentifier, password: string, opts: LoginOptions = {}): Promise<Credentials> {
    const identifier: UserIdentifier = typeof user === "string" ? { type: "m.id.user", user } : user;
    return this.login({ type: "m.login.password", identifier, password }, opts);
  }

  /** The token an SSO redirect returns (m.login.token). */
  loginWithToken(token: string, opts: LoginOptions = {}): Promise<Credentials> {
    return this.login({ type: "m.login.token", token }, opts);
  }

  /**
   * Register an account (https://spec.matrix.org/v1.19/client-server-api/#post_matrixclientv3register).
   * User-interactive authentication: flows made only of `m.login.dummy` are completed on their
   * own; for others (CAPTCHA, email, terms, registration tokens) pass `auth`, or the server's 401
   * is thrown as a MatrixError whose `data` holds the flows and session.
   */
  async register(username: string, password: string, opts: LoginOptions & { auth?: UiaCallback } = {}): Promise<Credentials> {
    const body: RegisterRequest = {
      username,
      password,
      device_id: opts.deviceId,
      initial_device_display_name: opts.initialDeviceDisplayName,
      refresh_token: opts.refreshToken ?? true,
    };
    const res = await withUserInteractiveAuth(
      (auth) => this.api.endpoint("POST /v3/register", {}, { auth: false, retryRateLimited: false, body: { ...body, auth } }),
      (session) => dummyAuth(session) ?? opts.auth?.(session),
    );
    return credentialsFrom(res);
  }

  /** Register a guest account (`kind=guest`): limited access, no password. */
  async registerGuest(opts: LoginOptions = {}): Promise<Credentials> {
    const res = await this.api.endpoint(
      "POST /v3/register",
      {},
      {
        auth: false,
        retryRateLimited: false,
        query: { kind: "guest" },
        body: { initial_device_display_name: opts.initialDeviceDisplayName, refresh_token: opts.refreshToken ?? true },
      },
    );
    return credentialsFrom(res);
  }

  /** Whether a username is free to register; false when taken, throws M_INVALID_USERNAME or M_EXCLUSIVE when not allowed. */
  async isUsernameAvailable(username: string): Promise<boolean> {
    try {
      const res = await this.api.endpoint("GET /v3/register/available", {}, { auth: false, query: { username } });
      return res.available === true;
    } catch (e) {
      if (e instanceof MatrixError && e.errcode === "M_USER_IN_USE") return false;
      throw e;
    }
  }

  /** Whether a registration token (m.login.registration_token) is still valid. */
  async isRegistrationTokenValid(token: string): Promise<boolean> {
    const res = await this.api.endpoint("GET /v1/register/m.login.registration_token/validity", {}, { auth: false, query: { token } });
    return res.valid === true;
  }

  /**
   * Ask the server to send a validation token for the m.login.email.identity or
   * m.login.msisdn stage. `purpose` picks the endpoint: registration, a password reset, or adding
   * the address to an account (that one needs an access token: use MatrixClient.account).
   * Keep `clientSecret` and the returned `sid` for the stage's `threepid_creds`.
   */
  requestEmailToken(
    purpose: "register" | "password",
    req: { clientSecret: string; email: string; sendAttempt: number; nextLink?: string },
  ): Promise<RequestTokenResponse> {
    const body = { client_secret: req.clientSecret, email: req.email, send_attempt: req.sendAttempt, next_link: req.nextLink };
    return purpose === "register"
      ? this.api.endpoint("POST /v3/register/email/requestToken", {}, { auth: false, body })
      : this.api.endpoint("POST /v3/account/password/email/requestToken", {}, { auth: false, body });
  }

  requestMsisdnToken(
    purpose: "register" | "password",
    req: { clientSecret: string; country: string; phoneNumber: string; sendAttempt: number; nextLink?: string },
  ): Promise<RequestTokenResponse> {
    const body = {
      client_secret: req.clientSecret,
      country: req.country,
      phone_number: req.phoneNumber,
      send_attempt: req.sendAttempt,
      next_link: req.nextLink,
    };
    return purpose === "register"
      ? this.api.endpoint("POST /v3/register/msisdn/requestToken", {}, { auth: false, body })
      : this.api.endpoint("POST /v3/account/password/msisdn/requestToken", {}, { auth: false, body });
  }

  /**
   * Reset a forgotten password: `auth` completes the m.login.email.identity (or msisdn) stage
   * with the `threepid_creds` of requestEmailToken("password", …).
   */
  async resetPassword(newPassword: string, auth: UiaCallback, opts: { logoutDevices?: boolean } = {}): Promise<void> {
    await withUserInteractiveAuth(
      (a) =>
        this.api.endpoint(
          "POST /v3/account/password",
          {},
          { auth: false, body: { new_password: newPassword, logout_devices: opts.logoutDevices, auth: a } },
        ),
      auth,
    );
  }

  /** The spec versions and unstable features the server supports. */
  versions(): Promise<VersionsResponse> {
    return this.api.endpoint("GET /versions", {}, { auth: false });
  }

  /** The server's support contacts (/.well-known/matrix/support); undefined when it publishes none. */
  async support(): Promise<WellKnownSupport | undefined> {
    try {
      return await this.api.endpoint("GET /.well-known/matrix/support", {}, { auth: false });
    } catch (e) {
      if (e instanceof MatrixError && e.status === 404) return undefined;
      throw e;
    }
  }

  /**
   * The SSO redirect URL to open in a browser (https://spec.matrix.org/v1.19/client-server-api/#client-login-via-sso).
   * The server sends the browser back to `redirectUrl` with a `loginToken` for loginWithToken.
   * `action` hints whether the user means to log in or to sign up.
   */
  ssoRedirectUrl(redirectUrl: string, idpId?: string, action?: "login" | "register"): string {
    const path = `/_matrix/client/v3/login/sso/redirect${idpId ? `/${encodeURIComponent(idpId)}` : ""}`;
    return this.api.url(path, { redirectUrl, action });
  }

  /**
   * Log in as a user of an application service (m.login.application_service): the request
   * carries the appservice's `as_token`, which the caller passes.
   */
  async loginAsApplicationService(asToken: string, user: string, opts: LoginOptions = {}): Promise<Credentials> {
    const api = new MatrixHttpApi({ baseUrl: this.api.baseUrl, http: this.http, tokens: { accessToken: () => asToken } });
    const res = await api.endpoint(
      "POST /v3/login",
      {},
      {
        retryRateLimited: false,
        body: {
          type: "m.login.application_service",
          identifier: { type: "m.id.user", user },
          device_id: opts.deviceId,
          initial_device_display_name: opts.initialDeviceDisplayName,
          refresh_token: opts.refreshToken ?? false,
        },
      },
    );
    return credentialsFrom(res);
  }

  private async login(
    body: { type: "m.login.password"; identifier: UserIdentifier; password: string } | { type: "m.login.token"; token: string },
    opts: LoginOptions,
  ): Promise<Credentials> {
    const res = await this.api.endpoint(
      "POST /v3/login",
      {},
      {
        auth: false,
        // Not retried on its own: a password login is not idempotent for rate-limit accounting.
        retryRateLimited: false,
        body: {
          ...body,
          device_id: opts.deviceId,
          initial_device_display_name: opts.initialDeviceDisplayName,
          refresh_token: opts.refreshToken ?? true,
        } satisfies LoginRequest,
      },
    );
    return credentialsFrom(res);
  }

  /** The base URL from /.well-known/matrix/client, checked against /versions (spec "Server Discovery"). */
  static async discover(serverName: string, http: HttpAdapter): Promise<string> {
    const wellKnown = new MatrixHttpApi({ baseUrl: `https://${serverName}`, http });
    let baseUrl = `https://${serverName}`;
    try {
      const res: Partial<WellKnownClient> = await wellKnown.endpoint("GET /.well-known/matrix/client", {}, { auth: false });
      const url = res["m.homeserver"]?.base_url;
      if (typeof url !== "string" || !/^https?:\/\/[^/]+/.test(url)) throw new Error("FAIL_PROMPT: invalid m.homeserver.base_url");
      baseUrl = url.replace(/\/+$/, "");
    } catch (e) {
      // A missing well-known (404) means: try the server name itself. Anything else is FAIL_PROMPT.
      if (!(e instanceof MatrixError && e.status === 404)) throw e;
    }
    const versions = await new MatrixHttpApi({ baseUrl, http }).endpoint("GET /versions", {}, { auth: false });
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
        if (c.refresh.kind === "matrix") {
          const res: RefreshResponse = await new MatrixHttpApi({ baseUrl: this.baseUrl, http: this.http }).endpoint(
            "POST /v3/refresh",
            {},
            {
              auth: false,
              body: { refresh_token: c.refreshToken },
            },
          );
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
