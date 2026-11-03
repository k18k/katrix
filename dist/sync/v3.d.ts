import type { MatrixHttpApi } from "../http/api.ts";
import type { SyncRequest, SyncResult, SyncTransport } from "./types.ts";
/** Options for the /sync filter (https://spec.matrix.org/v1.16/client-server-api/#filtering). */
export interface V3SyncOptions {
    /** Timeline events per room in a sync (default 20). */
    timelineLimit?: number;
    /** Lazy-load room members (default true): the client fetches full lists when it needs them. */
    lazyLoadMembers?: boolean;
    /** A filter of your own instead (an ID or a filter object). */
    filter?: string | Record<string, unknown>;
}
/** GET /_matrix/client/v3/sync (https://spec.matrix.org/v1.16/client-server-api/#get_matrixclientv3sync). */
export declare class SyncV3Transport implements SyncTransport {
    readonly kind = "v3";
    private readonly api;
    private readonly filter;
    constructor(api: MatrixHttpApi, opts?: V3SyncOptions);
    sync(req: SyncRequest): Promise<SyncResult>;
}
export declare function parseV3(res: Record<string, any>, initial: boolean): SyncResult;
