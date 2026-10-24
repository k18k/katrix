/**
 * Preload (--import) that makes Node.js look like React Native's Hermes to the SDK: the globals
 * Hermes lacks or ships incomplete are removed, and crypto is reduced to getRandomValues (what
 * react-native-get-random-values provides). Tests run under it with `npm run test:hermes`.
 *
 * Most of Node's own modules keep working: they use internal bindings, not these globals. Not
 * node:http and fetch, which load undici (it reads Buffer and WebAssembly from the globals), so
 * the tests under this shim speak HTTP over node:net (test/hermes/e2ee-http.test.ts).
 *
 * TextEncoder stays: Hermes has it natively since React Native 0.74, and @noble/curves needs it
 * when its ed25519 module is imported (it derives FROST domain tags at load time). The SDK itself
 * never uses it (src/util/utf8.ts); TextDecoder, which Hermes lacks, is removed.
 */
const g = globalThis as Record<string, unknown>;
const getRandomValues = (globalThis.crypto.getRandomValues as (a: Uint8Array) => Uint8Array).bind(globalThis.crypto);

export const REMOVED = ["TextDecoder", "WebAssembly", "Buffer", "structuredClone", "atob", "btoa", "URL", "URLSearchParams"];
for (const name of REMOVED) Object.defineProperty(g, name, { value: undefined, configurable: true, writable: true });
Object.defineProperty(g, "crypto", { value: Object.freeze({ getRandomValues }), configurable: true, writable: true });
g.__HERMES_SIMULATION__ = true;
