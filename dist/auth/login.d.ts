import { HttpAdapter } from "../http/adapter.js";
import { RequestTokenResponse } from "../shared/api/account.js";
import { Logger } from "../util/logger.js";
import { Credentials, CredentialsStore, TokenProvider } from "./types.js";
import { UiaCallback } from "./uia.js";
import { LoginFlow, UserIdentifier, VersionsResponse, WellKnownSupport } from "../shared/api/auth.js";
export interface LoginOptions {
  deviceId?: string;
  initialDeviceDisplayName?: string;
  /** Ask for a refresh token (default true); servers that do not issue them ignore it. */
  refreshToken?: boolean;
}
/** Login API calls that need no access token (https://spec.matrix.org/v1.16/client-server-api/#login). */
export declare class Auth {
  private readonly api;
  private readonly http;
  constructor(opts: {
    baseUrl: string;
    http: HttpAdapter;
    logger?: Logger;
  });
  /** The login types the server offers (GET /v3/login), with SSO identity providers. */
  loginFlows(): Promise<LoginFlow[]>;
  /** `user` is a localpart or a full user ID, or a full identifier for a third-party ID. */
  loginWithPassword(user: string | UserIdentifier, password: string, opts?: LoginOptions): Promise<Credentials>;
  /** The token an SSO redirect returns (m.login.token). */
  loginWithToken(token: string, opts?: LoginOptions): Promise<Credentials>;
  /**
   * Register an account (https://spec.matrix.org/v1.19/client-server-api/#post_matrixclientv3register).
   * User-interactive authentication: flows made only of `m.login.dummy` are completed on their
   * own; for others (CAPTCHA, email, terms, registration tokens) pass `auth`, or the server's 401
   * is thrown as a MatrixError whose `data` holds the flows and session.
   */
  register(username: string, password: string, opts?: LoginOptions & {
    auth?: UiaCallback;
  }): Promise<Credentials>;
  /** Register a guest account (`kind=guest`): limited access, no password. */
  registerGuest(opts?: LoginOptions): Promise<Credentials>;
  /** Whether a username is free to register; false when taken, throws M_INVALID_USERNAME or M_EXCLUSIVE when not allowed. */
  isUsernameAvailable(username: string): Promise<boolean>;
  /** Whether a registration token (m.login.registration_token) is still valid. */
  isRegistrationTokenValid(token: string): Promise<boolean>;
  /**
   * Ask the server to send a validation token for the m.login.email.identity or
   * m.login.msisdn stage. `purpose` picks the endpoint: registration, a password reset, or adding
   * the address to an account (that one needs an access token: use MatrixClient.account).
   * Keep `clientSecret` and the returned `sid` for the stage's `threepid_creds`.
   */
  requestEmailToken(purpose: "register" | "password", req: {
    clientSecret: string;
    email: string;
    sendAttempt: number;
    nextLink?: string;
  }): Promise<RequestTokenResponse>;
  requestMsisdnToken(purpose: "register" | "password", req: {
    clientSecret: string;
    country: string;
    phoneNumber: string;
    sendAttempt: number;
    nextLink?: string;
  }): Promise<RequestTokenResponse>;
  /**
   * Reset a forgotten password: `auth` completes the m.login.email.identity (or msisdn) stage
   * with the `threepid_creds` of requestEmailToken("password", …).
   */
  resetPassword(newPassword: string, auth: UiaCallback, opts?: {
    logoutDevices?: boolean;
  }): Promise<void>;
  /** The spec versions and unstable features the server supports. */
  versions(): Promise<VersionsResponse>;
  /** The server's support contacts (/.well-known/matrix/support); undefined when it publishes none. */
  support(): Promise<WellKnownSupport | undefined>;
  /**
   * The SSO redirect URL to open in a browser (https://spec.matrix.org/v1.19/client-server-api/#client-login-via-sso).
   * The server sends the browser back to `redirectUrl` with a `loginToken` for loginWithToken.
   * `action` hints whether the user means to log in or to sign up.
   */
  ssoRedirectUrl(redirectUrl: string, idpId?: string, action?: "login" | "register"): string;
  /**
   * Log in as a user of an application service (m.login.application_service): the request
   * carries the appservice's `as_token`, which the caller passes.
   */
  loginAsApplicationService(asToken: string, user: string, opts?: LoginOptions): Promise<Credentials>;
  private login;
  /** The base URL from /.well-known/matrix/client, checked against /versions (spec "Server Discovery"). */
  static discover(serverName: string, http: HttpAdapter): Promise<string>;
}
/**
 * Tokens from a login, refreshed with the refresh token when the server rejects the access token.
 * Concurrent requests that all see the expired token share one refresh.
 */
export declare class CredentialsTokenProvider implements TokenProvider {
  private credentials;
  private readonly http;
  private readonly baseUrl;
  private readonly store?;
  private readonly mutex;
  constructor(opts: {
    credentials: Credentials;
    baseUrl: string;
    http: HttpAdapter;
    store?: CredentialsStore;
  });
  current(): Credentials;
  accessToken(): string;
  refresh(): Promise<boolean>;
}
//# sourceMappingURL=login.d.ts.map