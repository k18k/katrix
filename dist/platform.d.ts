/**
 * The only module that reads platform globals. The SDK compiles against plain ECMAScript (no DOM,
 * no Node.js typings), so every global it needs is declared here with the smallest shape that
 * Node.js, browsers and React Native (Hermes) all provide.
 *
 * Deliberately not used anywhere in the SDK, because Hermes lacks them or ships incomplete
 * versions: `TextDecoder` and, for symmetry, `TextEncoder` (see util/utf8.ts; Hermes has
 * TextEncoder since React Native 0.74, and @noble/curves needs it at import), `atob`/`btoa` (util/base64.ts),
 * `URL`/`URLSearchParams` (util/query.ts), `crypto.subtle`, `WebAssembly`, `structuredClone`,
 * `AbortSignal.timeout`/`AbortSignal.any`, `Buffer`, `process`.
 */
export interface AbortSignalLike {
    readonly aborted: boolean;
    readonly reason?: unknown;
    addEventListener(type: "abort", listener: () => void, options?: {
        once?: boolean;
    }): void;
    removeEventListener(type: "abort", listener: () => void): void;
}
export interface AbortControllerLike {
    readonly signal: AbortSignalLike;
    abort(reason?: unknown): void;
}
type TimerHandle = unknown;
interface PlatformGlobals {
    setTimeout(fn: () => void, ms: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
    AbortController?: new () => AbortControllerLike;
    crypto?: {
        getRandomValues?<T extends Uint8Array>(array: T): T;
    };
    console?: {
        debug(...a: unknown[]): void;
        info(...a: unknown[]): void;
        warn(...a: unknown[]): void;
        error(...a: unknown[]): void;
    };
}
export declare function setTimer(fn: () => void, ms: number): TimerHandle;
export declare function clearTimer(handle: TimerHandle): void;
/** Resolves after `ms`, or rejects with an AbortError as soon as `signal` aborts. */
export declare function sleep(ms: number, signal?: AbortSignalLike): Promise<void>;
export declare function newAbortController(): AbortControllerLike;
export declare class AbortError extends Error {
    constructor();
}
export declare function abortError(): AbortError;
export declare function isAbortError(e: unknown): boolean;
/**
 * crypto.getRandomValues: native in Node.js and browsers; in React Native it comes from a
 * polyfill (react-native-get-random-values) that the app imports before the SDK.
 */
export declare function platformRandomValues(): ((array: Uint8Array) => Uint8Array) | undefined;
export declare function platformConsole(): PlatformGlobals["console"];
/** fetch as the HTTP adapter uses it (see http/adapter.ts). */
export type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
    signal?: AbortSignalLike;
}) => Promise<FetchResponseLike>;
export interface FetchResponseLike {
    readonly status: number;
    readonly headers: {
        get(name: string): string | null;
    };
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
}
export declare function platformFetch(): FetchLike | undefined;
export {};
