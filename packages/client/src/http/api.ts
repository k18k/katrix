import { describeError, noopLogger, type Logger } from "../util/logger.ts";
import { encodeQuery, type QueryValue } from "../util/query.ts";
import { abortError, clearTimer, isAbortError, newAbortController, setTimer, sleep, type AbortSignalLike } from "../platform.ts";
import type { HttpAdapter } from "./adapter.ts";
import { ConnectionError, MatrixError } from "./errors.ts";
import type { TokenProvider } from "../auth/types.ts";
import {
  endpointPath,
  endpointUrlPath,
  type ClientEndpoint,
  type EndpointParams,
  type EndpointRequest,
  type EndpointResponse,
  type MediaBody,
} from "@katrix/shared";

/** Options of an endpoint call: a body exactly when the endpoint takes one (ClientEndpoints in @katrix/shared). */
export type EndpointOptions<K extends ClientEndpoint> = Omit<RequestOptions, "body"> &
  (EndpointRequest<K> extends undefined ? { body?: undefined } : { body: EndpointRequest<K> });

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

/** The endpoints of the map whose response is a file (MediaBody), not JSON. */
const MEDIA_RESPONSE = /^GET \/v1\/media\/(download|thumbnail)\//;

function isMediaBody(body: unknown): body is MediaBody {
  return typeof body === "object" && body !== null && (body as MediaBody).data instanceof Uint8Array;
}

/** The file name of a Content-Disposition header (`filename*=UTF-8''…` or `filename="…"`). */
function dispositionFilename(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // A malformed escape: fall back to the plain parameter.
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/.exec(header);
  return plain ? (plain[1]?.replace(/\\(.)/g, "$1") ?? plain[2]) : undefined;
}

const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/** JSON requests to the Client-Server API. */
export class MatrixHttpApi {
  readonly baseUrl: string;
  private readonly http: HttpAdapter;
  private tokens?: TokenProvider;
  private readonly logger: Logger;

  constructor(opts: { baseUrl: string; http: HttpAdapter; tokens?: TokenProvider; logger?: Logger }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.http = opts.http;
    this.tokens = opts.tokens;
    this.logger = opts.logger ?? noopLogger;
  }

  setTokenProvider(tokens: TokenProvider | undefined): void {
    this.tokens = tokens;
  }

  /**
   * Call an endpoint of the shared endpoint map: the body and the response are typed by it, and
   * path parameters are filled in from `params`, each percent-encoded as one segment.
   */
  endpoint<K extends ClientEndpoint>(key: K, params: EndpointParams<K>, opts: EndpointOptions<K>): Promise<EndpointResponse<K>> {
    const space = key.indexOf(" ");
    const template = key.slice(space + 1);
    return this.request<EndpointResponse<K>>(
      key.slice(0, space),
      endpointPath(endpointUrlPath(template), params as Record<string, string>),
      {
        ...opts,
        prefix: "",
        responseType: opts.responseType ?? (MEDIA_RESPONSE.test(key) ? "bytes" : "json"),
      },
    );
  }

  /** The URL of a path under the server's base URL (for links the app opens itself, such as SSO redirects). */
  url(path: string, query?: Record<string, QueryValue>): string {
    const q = query ? encodeQuery(query) : "";
    return `${this.baseUrl}${path}${q ? `?${q}` : ""}`;
  }

  async request<T = Record<string, any>>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const prefix = opts.prefix ?? "/_matrix/client";
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, prefix + path, opts);
      } catch (e) {
        if (!(e instanceof MatrixError)) throw e;
        if (e.errcode === "M_LIMIT_EXCEEDED" && opts.retryRateLimited !== false && attempt < MAX_RATE_LIMIT_RETRIES) {
          const wait = Math.min(e.retryAfterMs ?? 1000 * 2 ** attempt, MAX_RATE_LIMIT_WAIT_MS);
          this.logger.debug("rate limited, retrying", { method, path, wait });
          await sleep(wait, opts.signal);
          continue;
        }
        // An expired access token: refresh once and retry (refresh tokens, or OAuth 2.0).
        // https://spec.matrix.org/v1.16/client-server-api/#soft-logout
        if (e.status === 401 && e.errcode === "M_UNKNOWN_TOKEN" && opts.auth !== false && !refreshed && this.tokens?.refresh) {
          refreshed = true;
          if (await this.tokens.refresh()) continue;
        }
        throw e;
      }
    }
  }

  private async once<T>(method: string, path: string, opts: RequestOptions): Promise<T> {
    const query = opts.query ? encodeQuery(opts.query) : "";
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.auth !== false) {
      const token = this.tokens?.accessToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    let body: string | Uint8Array | undefined;
    if (isMediaBody(opts.body)) {
      headers["content-type"] = opts.body.contentType ?? "application/octet-stream";
      body = opts.body.data;
    } else if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    if (opts.responseType === "bytes") headers.accept = "*/*";

    // One controller for the caller's signal and the timeout.
    let controller;
    let timer: unknown;
    let onAbort: (() => void) | undefined;
    if (opts.signal || opts.timeoutMs) {
      controller = newAbortController();
      if (opts.signal) {
        if (opts.signal.aborted) throw abortError();
        const c = controller;
        onAbort = () => c.abort();
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (opts.timeoutMs) {
        const c = controller;
        timer = setTimer(() => c.abort(), opts.timeoutMs);
      }
    }

    const request = { method, path };
    try {
      let res;
      try {
        res = await this.http.request({ method, url, headers, body, signal: controller?.signal });
      } catch (e) {
        if (opts.signal?.aborted) throw abortError();
        if (isAbortError(e) || controller?.signal.aborted) throw new ConnectionError(request, new Error("timeout"));
        this.logger.debug("request failed", { method, path, ...describeError(e) });
        throw new ConnectionError(request, e);
      }
      if (opts.responseType === "bytes" && res.status >= 200 && res.status < 300) {
        const media: MediaBody = {
          data: await res.bytes(),
          contentType: res.header("content-type"),
          filename: dispositionFilename(res.header("content-disposition")),
        };
        return media as T;
      }
      const text = await res.text();
      let json: unknown = {};
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          if (res.status >= 200 && res.status < 300)
            throw new MatrixError(res.status, { errcode: "M_NOT_JSON", error: "Response is not JSON" }, request);
          json = {};
        }
      }
      if (res.status < 200 || res.status >= 300) {
        const data = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
        const retryAfter = res.header("retry-after");
        if (data.retry_after_ms === undefined && retryAfter && /^\d+$/.test(retryAfter)) data.retry_after_ms = Number(retryAfter) * 1000;
        if (res.status === 429 && data.errcode === undefined) data.errcode = "M_LIMIT_EXCEEDED";
        throw new MatrixError(res.status, data, request);
      }
      return json as T;
    } finally {
      if (timer !== undefined) clearTimer(timer);
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}
