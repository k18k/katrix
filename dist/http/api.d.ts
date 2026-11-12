import { Logger } from "../util/logger.js";
import { QueryValue } from "../util/query.js";
import { AbortSignalLike } from "../platform.js";
import { HttpAdapter } from "./adapter.js";
import { TokenProvider } from "../auth/types.js";
import { ClientEndpoint, EndpointParams, EndpointRequest, EndpointResponse } from "../shared/api/endpoints.js";
/** Options of an endpoint call: a body exactly when the endpoint takes one (ClientEndpoints in @katrix/shared). */
export type EndpointOptions<K extends ClientEndpoint> = Omit<RequestOptions, "body"> & (EndpointRequest<K> extends undefined ? {
  body?: undefined;
} : {
  body: EndpointRequest<K>;
});
export interface RequestOptions {
  query?: Record<string, QueryValue>;
  /** JSON, or a MediaBody, which is sent as its bytes with its content type. */
  body?: unknown;
  /** Read the response as bytes (a MediaBody) instead of JSON. */
  responseType?: "json" | "bytes";
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
  /**
   * Call an endpoint of the shared endpoint map: the body and the response are typed by it, and
   * path parameters are filled in from `params`, each percent-encoded as one segment.
   */
  endpoint<K extends ClientEndpoint>(key: K, params: EndpointParams<K>, opts: EndpointOptions<K>): Promise<EndpointResponse<K>>;
  /** The URL of a path under the server's base URL (for links the app opens itself, such as SSO redirects). */
  url(path: string, query?: Record<string, QueryValue>): string;
  request<T = Record<string, any>>(method: string, path: string, opts?: RequestOptions): Promise<T>;
  private once;
}
//# sourceMappingURL=api.d.ts.map