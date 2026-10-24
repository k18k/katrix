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
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
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
  crypto?: { getRandomValues?<T extends Uint8Array>(array: T): T };
  console?: { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

const g = globalThis as unknown as PlatformGlobals;

export function setTimer(fn: () => void, ms: number): TimerHandle {
  return g.setTimeout(fn, ms);
}

export function clearTimer(handle: TimerHandle): void {
  g.clearTimeout(handle);
}

/** Resolves after `ms`, or rejects with an AbortError as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignalLike): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimer(handle);
      reject(abortError());
    };
    const handle = setTimer(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function newAbortController(): AbortControllerLike {
  if (!g.AbortController) throw new Error("AbortController is not available on this platform");
  return new g.AbortController();
}

export class AbortError extends Error {
  constructor() {
    super("The operation was aborted");
    this.name = "AbortError";
  }
}

export function abortError(): AbortError {
  return new AbortError();
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/**
 * crypto.getRandomValues: native in Node.js and browsers; in React Native it comes from a
 * polyfill (react-native-get-random-values) that the app imports before the SDK.
 */
export function platformRandomValues(): ((array: Uint8Array) => Uint8Array) | undefined {
  const c = g.crypto;
  if (!c || typeof c.getRandomValues !== "function") return undefined;
  return (array) => c.getRandomValues!(array);
}

export function platformConsole(): PlatformGlobals["console"] {
  return g.console;
}

/** fetch as the HTTP adapter uses it (see http/adapter.ts). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignalLike },
) => Promise<FetchResponseLike>;

export interface FetchResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export function platformFetch(): FetchLike | undefined {
  const f = (globalThis as unknown as { fetch?: unknown }).fetch;
  return typeof f === "function" ? (f.bind(globalThis) as FetchLike) : undefined;
}
