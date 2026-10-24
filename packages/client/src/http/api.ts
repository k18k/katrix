import { describeError, noopLogger, type Logger } from "../util/logger.ts";
import { encodeQuery, type QueryValue } from "../util/query.ts";
import { abortError, clearTimer, isAbortError, newAbortController, setTimer, sleep, type AbortSignalLike } from "../platform.ts";
import type { HttpAdapter } from "./adapter.ts";
import { ConnectionError, MatrixError } from "./errors.ts";
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
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

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
