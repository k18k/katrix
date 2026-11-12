import { WhoisResponse } from "../shared/api/account.js";
import { MatrixHttpApi } from "../http/api.js";
/**
 * Server administration through the Client-Server API
 * (https://spec.matrix.org/v1.19/client-server-api/#server-administration): for server admins,
 * and, for ping, application services. The server decides who may call these.
 */
export declare class AdminApi {
  private readonly api;
  constructor(api: MatrixHttpApi);
  /** A user's devices and the connections they were seen from. */
  whois(userId: string): Promise<WhoisResponse>;
  /** Whether an account is suspended (it can read but not act; https://spec.matrix.org/v1.19/client-server-api/#account-suspension). */
  isSuspended(userId: string): Promise<boolean>;
  setSuspended(userId: string, suspended: boolean): Promise<boolean>;
  /** Whether an account is locked (it cannot use the API at all until unlocked). */
  isLocked(userId: string): Promise<boolean>;
  setLocked(userId: string, locked: boolean): Promise<boolean>;
  /**
   * As an application service: ask the homeserver to ping it, to check that the two can reach
   * each other. Resolves with the round trip in milliseconds.
   */
  pingAppservice(appserviceId: string, transactionId?: string): Promise<number>;
}
//# sourceMappingURL=admin.d.ts.map