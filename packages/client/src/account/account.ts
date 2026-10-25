import type { MatrixHttpApi } from "../http/api.ts";
import { MatrixError } from "../http/errors.ts";
import { withUserInteractiveAuth, type UiaCallback } from "../auth/uia.ts";
import type {
  Capabilities,
  Filter,
  LoginTokenResponse,
  OpenIdToken,
  RequestTokenResponse,
  ThirdPartyIdentifier,
  ThreePidMedium,
} from "@katrix/shared";

/**
 * The logged-in account (https://spec.matrix.org/v1.19/client-server-api/#account-registration-and-management):
 * password, deactivation, third-party IDs, account data, filters, ignored users, OpenID and login
 * tokens. Calls that need user-interactive authentication take a UiaCallback (passwordAuth for
 * the common case).
 */
export class AccountApi {
  private readonly api: MatrixHttpApi;
  private readonly userId: string;
  private capabilitiesCache?: Capabilities;

  constructor(api: MatrixHttpApi, userId: string) {
    this.api = api;
    this.userId = userId;
  }

  whoami(): Promise<{ user_id: string; device_id?: string; is_guest?: boolean }> {
    return this.api.endpoint("GET /v3/account/whoami", {}, {});
  }

  /** What the server lets this account do (https://spec.matrix.org/v1.19/client-server-api/#capabilities-negotiation). */
  async capabilities(opts: { refresh?: boolean } = {}): Promise<Capabilities> {
    if (!this.capabilitiesCache || opts.refresh)
      this.capabilitiesCache = (await this.api.endpoint("GET /v3/capabilities", {}, {})).capabilities ?? {};
    return this.capabilitiesCache;
  }

  /** Change the password. `logoutDevices` (default true on the server) logs out every other device. */
  async changePassword(newPassword: string, auth: UiaCallback, opts: { logoutDevices?: boolean } = {}): Promise<void> {
    await withUserInteractiveAuth(
      (a) =>
        this.api.endpoint(
          "POST /v3/account/password",
          {},
          { body: { new_password: newPassword, logout_devices: opts.logoutDevices, auth: a } },
        ),
      auth,
    );
  }

  /**
   * Deactivate the account, for good. `erase` asks the server to forget what the user sent, as
   * far as it can. Resolves with whether the identity server unbound the account's 3PIDs.
   */
  async deactivate(auth: UiaCallback, opts: { erase?: boolean; idServer?: string } = {}): Promise<"success" | "no-support"> {
    const res = await withUserInteractiveAuth(
      (a) => this.api.endpoint("POST /v3/account/deactivate", {}, { body: { auth: a, erase: opts.erase, id_server: opts.idServer } }),
      auth,
    );
    return res.id_server_unbind_result;
  }

  // ─── Third-party IDs ──────────────────────────────────────────────────────

  async threePids(): Promise<ThirdPartyIdentifier[]> {
    return (await this.api.endpoint("GET /v3/account/3pid", {}, {})).threepids ?? [];
  }

  /** Start adding an email address: the server sends a link or code to it. */
  requestEmailToken(req: { clientSecret: string; email: string; sendAttempt: number; nextLink?: string }): Promise<RequestTokenResponse> {
    return this.api.endpoint(
      "POST /v3/account/3pid/email/requestToken",
      {},
      { body: { client_secret: req.clientSecret, email: req.email, send_attempt: req.sendAttempt, next_link: req.nextLink } },
    );
  }

  requestMsisdnToken(req: {
    clientSecret: string;
    country: string;
    phoneNumber: string;
    sendAttempt: number;
    nextLink?: string;
  }): Promise<RequestTokenResponse> {
    return this.api.endpoint(
      "POST /v3/account/3pid/msisdn/requestToken",
      {},
      {
        body: {
          client_secret: req.clientSecret,
          country: req.country,
          phone_number: req.phoneNumber,
          send_attempt: req.sendAttempt,
          next_link: req.nextLink,
        },
      },
    );
  }

  /** Finish adding a validated 3PID to the account (`sid` from requestEmailToken or requestMsisdnToken). */
  async addThreePid(clientSecret: string, sid: string, auth: UiaCallback): Promise<void> {
    await withUserInteractiveAuth(
      (a) => this.api.endpoint("POST /v3/account/3pid/add", {}, { body: { client_secret: clientSecret, sid, auth: a } }),
      auth,
    );
  }

  /** Publish a validated 3PID on an identity server. */
  async bindThreePid(req: { clientSecret: string; sid: string; idServer: string; idAccessToken: string }): Promise<void> {
    await this.api.endpoint(
      "POST /v3/account/3pid/bind",
      {},
      { body: { client_secret: req.clientSecret, sid: req.sid, id_server: req.idServer, id_access_token: req.idAccessToken } },
    );
  }

  async deleteThreePid(medium: ThreePidMedium, address: string, idServer?: string): Promise<"success" | "no-support"> {
    const res = await this.api.endpoint("POST /v3/account/3pid/delete", {}, { body: { medium, address, id_server: idServer } });
    return res.id_server_unbind_result;
  }

  async unbindThreePid(medium: ThreePidMedium, address: string, idServer?: string): Promise<"success" | "no-support"> {
    const res = await this.api.endpoint("POST /v3/account/3pid/unbind", {}, { body: { medium, address, id_server: idServer } });
    return res.id_server_unbind_result;
  }

  // ─── Account data ─────────────────────────────────────────────────────────

  /** Global account data from the server (MatrixClient.getAccountData has what sync delivered). Undefined when unset. */
  async getAccountData(type: string): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.api.endpoint("GET /v3/user/:userId/account_data/:type", { userId: this.userId, type }, {});
    } catch (e) {
      if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return undefined;
      throw e;
    }
  }

  async setAccountData(type: string, content: Record<string, unknown>): Promise<void> {
    await this.api.endpoint("PUT /v3/user/:userId/account_data/:type", { userId: this.userId, type }, { body: content });
  }

  async getRoomAccountData(roomId: string, type: string): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.api.endpoint("GET /v3/user/:userId/rooms/:roomId/account_data/:type", { userId: this.userId, roomId, type }, {});
    } catch (e) {
      if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return undefined;
      throw e;
    }
  }

  async setRoomAccountData(roomId: string, type: string, content: Record<string, unknown>): Promise<void> {
    await this.api.endpoint(
      "PUT /v3/user/:userId/rooms/:roomId/account_data/:type",
      { userId: this.userId, roomId, type },
      { body: content },
    );
  }

  // ─── Ignored users ────────────────────────────────────────────────────────

  /** The users whose events the server hides from this account (m.ignored_user_list). */
  async ignoredUsers(): Promise<string[]> {
    const content = await this.getAccountData("m.ignored_user_list");
    const ignored = content?.ignored_users;
    return typeof ignored === "object" && ignored !== null ? Object.keys(ignored) : [];
  }

  /**
   * Ignore or stop ignoring users. The list is one account data event, so this reads it from the
   * server and writes it back: two devices changing it at the same moment can lose one change.
   */
  async setIgnored(userIds: string[], ignored: boolean): Promise<void> {
    const list = new Set(await this.ignoredUsers());
    for (const id of userIds) {
      if (ignored) list.add(id);
      else list.delete(id);
    }
    await this.setAccountData("m.ignored_user_list", { ignored_users: Object.fromEntries([...list].map((id) => [id, {}])) });
  }

  // ─── Filters ──────────────────────────────────────────────────────────────

  /** Store a filter on the server; its ID can be passed to /sync as `filter`. */
  async createFilter(filter: Filter): Promise<string> {
    return (await this.api.endpoint("POST /v3/user/:userId/filter", { userId: this.userId }, { body: filter })).filter_id;
  }

  getFilter(filterId: string): Promise<Filter> {
    return this.api.endpoint("GET /v3/user/:userId/filter/:filterId", { userId: this.userId, filterId }, {});
  }

  // ─── Tokens ───────────────────────────────────────────────────────────────

  /** An OpenID token that proves who the user is to a third party (an integration manager, a widget). */
  requestOpenIdToken(): Promise<OpenIdToken> {
    return this.api.endpoint("POST /v3/user/:userId/openid/request_token", { userId: this.userId }, { body: {} });
  }

  /**
   * A short-lived m.login.token for logging in another device as this user (QR login, for
   * example; https://spec.matrix.org/v1.19/client-server-api/#post_matrixclientv1loginget_token).
   */
  getLoginToken(auth?: UiaCallback): Promise<LoginTokenResponse> {
    return withUserInteractiveAuth((a) => this.api.endpoint("POST /v1/login/get_token", {}, { body: { auth: a } }), auth);
  }

  /** Log out every device of the account, this one included. */
  async logoutAll(): Promise<void> {
    await this.api.endpoint("POST /v3/logout/all", {}, { body: {} });
  }
}
