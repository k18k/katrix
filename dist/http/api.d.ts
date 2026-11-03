import { type Logger } from "../util/logger.ts";
import { type QueryValue } from "../util/query.ts";
import { type AbortSignalLike } from "../platform.ts";
import type { HttpAdapter } from "./adapter.ts";
import type { TokenProvider } from "../auth/types.ts";
export interface RequestOptions {
    query?: Record<string, QueryValue>;
    body?: unknown;
    /** Send the access token (default true). */
    auth?: boolean;
    signal?: AbortSignalLike;
    /** Abort the request after this long. */
    timeoutMs?: number;
    /**
     * Wait and retry when the server answers 429 M_LIMIT_EXCEEDED (default true). Safe for Matrix
     * requests in general: sends carry transaction IDs, and a rate-limited request did nothing.
     */
    retryRateLimited?: boolean;
    /** Path prefix (default /_matrix/client). */
    prefix?: string;
}
/** JSON requests to the Client-Server API. */
export declare class MatrixHttpApi {
    readonly baseUrl: string;
    private readonly http;
    private tokens?;
    private readonly logger;
    constructor(opts: {
        baseUrl: string;
        http: HttpAdapter;
        tokens?: TokenProvider;
        logger?: Logger;
    });
    setTokenProvider(tokens: TokenProvider | undefined): void;
    request<T = Record<string, any>>(method: string, path: string, opts?: RequestOptions): Promise<T>;
    private once;
}
