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
const g = globalThis;
export function setTimer(fn, ms) {
    return g.setTimeout(fn, ms);
}
export function clearTimer(handle) {
    g.clearTimeout(handle);
}
/** Resolves after `ms`, or rejects with an AbortError as soon as `signal` aborts. */
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted)
            return reject(abortError());
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
export function newAbortController() {
    if (!g.AbortController)
        throw new Error("AbortController is not available on this platform");
    return new g.AbortController();
}
export class AbortError extends Error {
    constructor() {
        super("The operation was aborted");
        this.name = "AbortError";
    }
}
export function abortError() {
    return new AbortError();
}
export function isAbortError(e) {
    return e instanceof Error && e.name === "AbortError";
}
/**
 * crypto.getRandomValues: native in Node.js and browsers; in React Native it comes from a
 * polyfill (react-native-get-random-values) that the app imports before the SDK.
 */
export function platformRandomValues() {
    const c = g.crypto;
    if (!c || typeof c.getRandomValues !== "function")
        return undefined;
    return (array) => c.getRandomValues(array);
}
export function platformConsole() {
    return g.console;
}
export function platformFetch() {
    const f = globalThis.fetch;
    return typeof f === "function" ? f.bind(globalThis) : undefined;
}
