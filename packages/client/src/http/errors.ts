/**
 * An error response from the homeserver (https://spec.matrix.org/v1.16/client-server-api/#standard-error-response).
 * Carries what the server said and the request's method and path, never its headers or body
 * (which hold access tokens and passwords).
 */
export class MatrixError extends Error {
  readonly status: number;
  readonly errcode: string;
  /** The server's `error` text. */
  readonly serverMessage?: string;
  readonly retryAfterMs?: number;
  /** The whole error body (for fields such as UIA `flows` or `soft_logout`). */
  readonly data: Record<string, unknown>;

  constructor(status: number, data: Record<string, unknown>, request: { method: string; path: string }) {
    const errcode = typeof data.errcode === "string" ? data.errcode : "M_UNKNOWN";
    const serverMessage = typeof data.error === "string" ? data.error : undefined;
    super(`${request.method} ${request.path}: ${status} ${errcode}${serverMessage ? `: ${serverMessage}` : ""}`);
    this.name = "MatrixError";
    this.status = status;
    this.errcode = errcode;
    this.serverMessage = serverMessage;
    this.data = data;
    if (typeof data.retry_after_ms === "number") this.retryAfterMs = data.retry_after_ms;
  }
}

/** The request did not get an HTTP response (network down, DNS, TLS, timeout). */
export class ConnectionError extends Error {
  constructor(request: { method: string; path: string }, cause?: unknown) {
    super(`${request.method} ${request.path}: no response${cause instanceof Error && cause.name ? ` (${cause.name})` : ""}`);
    this.name = "ConnectionError";
  }
}
