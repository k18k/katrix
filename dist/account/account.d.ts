import { WhoamiResponse } from "../shared/api/auth.js";
import { MatrixHttpApi } from "../http/api.js";
import { UiaCallback } from "../auth/uia.js";
import { Capabilities, Filter, LoginTokenResponse, OpenIdToken, RequestTokenResponse, ThirdPartyIdentifier, ThreePidMedium } from "../shared/api/account.js";
/**
 * The logged-in account (https://spec.matrix.org/v1.19/client-server-api/#account-registration-and-management):
 * password, deactivation, third-party IDs, account data, filters, ignored users, OpenID and login
 * tokens. Calls that need user-interactive authentication take a UiaCallback (passwordAuth for
 * the common case).
 */
export declare class AccountApi {
  private readonly api;
  private readonly userId;
  private capabilitiesCache?;
  constructor(api: MatrixHttpApi, userId: string);
  whoami(): Promise<WhoamiResponse>;
  /** What the server lets this account do (https://spec.matrix.org/v1.19/client-server-api/#capabilities-negotiation). */
  capabilities(opts?: {
    refresh?: boolean;
  }): Promise<Capabilities>;
  /** Change the password. `logoutDevices` (default true on the server) logs out every other device. */
  changePassword(newPassword: string, auth: UiaCallback, opts?: {
    logoutDevices?: boolean;
  }): Promise<void>;
  /**
   * Deactivate the account, for good. `erase` asks the server to forget what the user sent, as
   * far as it can. Resolves with whether the identity server unbound the account's 3PIDs.
   */
  deactivate(auth: UiaCallback, opts?: {
    erase?: boolean;
    idServer?: string;
  }): Promise<"no-support" | "success">;
  threePids(): Promise<ThirdPartyIdentifier[]>;
  /** Start adding an email address: the server sends a link or code to it. */
  requestEmailToken(req: {
    clientSecret: string;
    email: string;
    sendAttempt: number;
    nextLink?: string;
  }): Promise<RequestTokenResponse>;
  requestMsisdnToken(req: {
    clientSecret: string;
    country: string;
    phoneNumber: string;
    sendAttempt: number;
    nextLink?: string;
  }): Promise<RequestTokenResponse>;
  /** Finish adding a validated 3PID to the account (`sid` from requestEmailToken or requestMsisdnToken). */
  addThreePid(clientSecret: string, sid: string, auth: UiaCallback): Promise<void>;
  /** Publish a validated 3PID on an identity server. */
  bindThreePid(req: {
    clientSecret: string;
    sid: string;
    idServer: string;
    idAccessToken: string;
  }): Promise<void>;
  deleteThreePid(medium: ThreePidMedium, address: string, idServer?: string): Promise<"no-support" | "success">;
  unbindThreePid(medium: ThreePidMedium, address: string, idServer?: string): Promise<"no-support" | "success">;
  /** Global account data from the server (MatrixClient.getAccountData has what sync delivered). Undefined when unset. */
  getAccountData(type: string): Promise<{
    [x: string]: unknown;
  } | undefined>;
  setAccountData(type: string, content: Record<string, unknown>): Promise<void>;
  getRoomAccountData(roomId: string, type: string): Promise<{
    [x: string]: unknown;
  } | undefined>;
  setRoomAccountData(roomId: string, type: string, content: Record<string, unknown>): Promise<void>;
  /** The users whose events the server hides from this account (m.ignored_user_list). */
  ignoredUsers(): Promise<string[]>;
  /**
   * Ignore or stop ignoring users. The list is one account data event, so this reads it from the
   * server and writes it back: two devices changing it at the same moment can lose one change.
   */
  setIgnored(userIds: string[], ignored: boolean): Promise<void>;
  /** Store a filter on the server; its ID can be passed to /sync as `filter`. */
  createFilter(filter: Filter): Promise<string>;
  getFilter(filterId: string): Promise<Filter>;
  /** An OpenID token that proves who the user is to a third party (an integration manager, a widget). */
  requestOpenIdToken(): Promise<OpenIdToken>;
  /**
   * A short-lived m.login.token for logging in another device as this user (QR login, for
   * example; https://spec.matrix.org/v1.19/client-server-api/#post_matrixclientv1loginget_token).
   */
  getLoginToken(auth?: UiaCallback): Promise<LoginTokenResponse>;
  /** Log out every device of the account, this one included. */
  logoutAll(): Promise<void>;
}
//# sourceMappingURL=account.d.ts.map