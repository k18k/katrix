import { SyncResponse } from "../shared/api/sync.js";
import { MatrixHttpApi } from "../http/api.js";
import { SyncRequest, SyncResult, SyncTransport } from "./types.js";
/** Options for the /sync filter (https://spec.matrix.org/v1.16/client-server-api/#filtering). */
export interface V3SyncOptions {
  /** Timeline events per room in a sync (default 20). */
  timelineLimit?: number;
  /** Lazy-load room members (default true): the client fetches full lists when it needs them. */
  lazyLoadMembers?: boolean;
  /** A filter of your own instead (an ID or a filter object). */
  filter?: string | Record<string, unknown>;
  /**
   * Ask for the state at the end of the timeline (`use_state_after`, v1.16; default true) rather
   * than at its start: the room state is then what the server resolved, not a guess from the
   * timeline's state events. Servers that do not know the parameter answer as before.
   */
  useStateAfter?: boolean;
}
/** GET /_matrix/client/v3/sync (https://spec.matrix.org/v1.16/client-server-api/#get_matrixclientv3sync). */
export declare class SyncV3Transport implements SyncTransport {
  readonly kind = "v3";
  private readonly api;
  private readonly filter;
  private readonly useStateAfter;
  constructor(api: MatrixHttpApi, opts?: V3SyncOptions);
  sync(req: SyncRequest): Promise<SyncResult>;
}
/**
 * The response is typed as the spec's SyncResponse (@katrix/shared) but read as untrusted data:
 * every field is checked, and anything malformed is skipped rather than trusted.
 */
export declare function parseV3(response: SyncResponse | Record<string, unknown>, initial: boolean): SyncResult;
//# sourceMappingURL=v3.d.ts.map