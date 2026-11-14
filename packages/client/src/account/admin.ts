import type { MatrixHttpApi } from "../http/api.ts";

/**
 * Server administration through the Client-Server API
 * (https://spec.matrix.org/v1.19/client-server-api/#server-administration): for server admins,
 * and, for ping, application services. The server decides who may call these.
 */
export class AdminApi {
  private readonly api: MatrixHttpApi;

  constructor(api: MatrixHttpApi) {
    this.api = api;
  }

  /** A user's devices and the connections they were seen from. */
  whois(userId: string) {
    return this.api.endpoint("GET /v3/admin/whois/:userId", { userId }, {});
  }

  /** Whether an account is suspended (it can read but not act; https://spec.matrix.org/v1.19/client-server-api/#account-suspension). */
  async isSuspended(userId: string) {
    return (await this.api.endpoint("GET /v1/admin/suspend/:userId", { userId }, {})).suspended;
  }

  async setSuspended(userId: string, suspended: boolean) {
    return (await this.api.endpoint("PUT /v1/admin/suspend/:userId", { userId }, { body: { suspended } })).suspended;
  }

  /** Whether an account is locked (it cannot use the API at all until unlocked). */
  async isLocked(userId: string) {
    return (await this.api.endpoint("GET /v1/admin/lock/:userId", { userId }, {})).locked;
  }

  async setLocked(userId: string, locked: boolean) {
    return (await this.api.endpoint("PUT /v1/admin/lock/:userId", { userId }, { body: { locked } })).locked;
  }

  /**
   * As an application service: ask the homeserver to ping it, to check that the two can reach
   * each other. Resolves with the round trip in milliseconds.
   */
  async pingAppservice(appserviceId: string, transactionId?: string) {
    const res = await this.api.endpoint(
      "POST /v1/appservice/:appserviceId/ping",
      { appserviceId },
      { body: { transaction_id: transactionId } },
    );
    return res.duration_ms;
  }
}
