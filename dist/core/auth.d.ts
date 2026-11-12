import { AppServiceRegistration } from "./appservices.js";
import { Homeserver } from "../homeserver.js";
export interface Session {
  userId: string;
  deviceId: string;
  accessToken: string;
  isGuest: boolean;
  isAdmin: boolean;
  /** The account is locked: only logging out is allowed. */
  locked?: boolean;
  /** The account is suspended: see `assertNotSuspended`. */
  suspended?: boolean;
  /** Set when the request was made with an application service token. */
  appservice?: AppServiceRegistration;
  /**
   * The token comes from the OAuth 2.0 API (this server's or a delegated one), so endpoints that
   * need User-Interactive Authentication send the user to account management instead.
   */
  oauth?: boolean;
}
export interface CreatedSession {
  user_id: string;
  device_id: string;
  access_token: string;
  refresh_token?: string;
  expires_in_ms?: number;
  /** OAuth 2.0 API: the scope the tokens were issued for. */
  scope?: string;
}
export declare class AuthService {
  private hs;
  private cache;
  constructor(hs: Homeserver);
  authenticate(token: string, ip: string | null): Promise<Session>;
  /** Create (or reuse) a device and issue a fresh access token for it. */
  createSession(userId: string, opts?: {
    deviceId?: string;
    displayName?: string;
    refreshToken?: boolean;
    /** OAuth 2.0 API: the client the tokens are issued to. */
    clientId?: string;
    /** Access token lifetime; default `accessTokenLifetimeMs` (for tokens with a refresh token). */
    lifetimeMs?: number;
    /** OAuth 2.0 API: the scope granted. */
    scope?: string;
  }): Promise<CreatedSession>;
  /** Create a device without tokens (also used by application services, MSC4190). */
  createDevice(userId: string, deviceId: string, displayName?: string): Promise<void>;
  issueToken(userId: string, deviceId: string, withRefresh: boolean, opts?: {
    clientId?: string | null;
    lifetimeMs?: number;
    parent?: string;
    scope?: string | null;
  }): Promise<CreatedSession>;
  /**
   * Exchange a refresh token for new tokens.
   *
   * https://github.com/k18k/katrix/issues/66: the old row used to be deleted
   * at once, so a client whose response was lost could not retry and was logged out, and a
   * refresh token used twice went unnoticed. As the OAuth 2.0 API asks (and the legacy API
   * allows): the old refresh token keeps working until the new access token is first used; a
   * retry before that replaces the unused tokens. Once the new token was used, the old refresh
   * token is spent, and presenting it again means it leaked, so the device is logged out.
   */
  refresh(refreshToken: string, opts?: {
    clientId?: string | null;
    lifetimeMs?: number;
  }): Promise<CreatedSession>;
  /** Drop cached sessions of a user (after admin/deactivation changes). */
  invalidateUser(userId: string): Promise<void>;
  /** Issue a short-lived single-use `m.login.token` for a user (SSO, or host-app sign-in). */
  createLoginToken(userId: string, ttlMs?: number): Promise<string>;
  /** Redeem a login token; returns the user ID or throws. */
  consumeLoginToken(token: string): Promise<string>;
  revokeToken(token: string): Promise<void>;
  revokeDeviceTokens(userId: string, deviceId: string): Promise<void>;
  deleteDevice(userId: string, deviceId: string): Promise<void>;
  deleteAllDevices(userId: string, except?: string): Promise<void>;
}
//# sourceMappingURL=auth.d.ts.map