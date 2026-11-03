/**
 * An error response from the homeserver (https://spec.matrix.org/v1.16/client-server-api/#standard-error-response).
 * Carries what the server said and the request's method and path, never its headers or body
 * (which hold access tokens and passwords).
 */
export declare class MatrixError extends Error {
    readonly status: number;
    readonly errcode: string;
    /** The server's `error` text. */
    readonly serverMessage?: string;
    readonly retryAfterMs?: number;
    /** The whole error body (for fields such as UIA `flows` or `soft_logout`). */
    readonly data: Record<string, unknown>;
    constructor(status: number, data: Record<string, unknown>, request: {
        method: string;
        path: string;
    });
}
/** The request did not get an HTTP response (network down, DNS, TLS, timeout). */
export declare class ConnectionError extends Error {
    constructor(request: {
        method: string;
        path: string;
    }, cause?: unknown);
}
