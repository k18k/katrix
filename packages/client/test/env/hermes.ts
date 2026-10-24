/**
 * Preload (--import) that makes Node.js look like React Native's Hermes to the SDK: the globals
 * Hermes lacks or ships incomplete are removed, and crypto is reduced to getRandomValues (what
 * react-native-get-random-values provides). Tests run under it with `npm run test:hermes`.
 *
 * Node's own modules keep working: they use internal bindings, not these globals.
 *
 * TextEncoder stays: Hermes has it natively since React Native 0.74, and @noble/curves needs it
 * when its ed25519 module is imported (it derives FROST domain tags at load time). The SDK itself
 * never uses it (src/util/utf8.ts); TextDecoder, which Hermes lacks, is removed.
 */
// Node's HTTP stack (undici, loaded by node:http in recent Node.js) reads the global Buffer while
// it initialises: load it first, so the tests' own HTTP plumbing works after the removal.
await import("node:http");

const g = globalThis as Record<string, unknown>;
const getRandomValues = (globalThis.crypto.getRandomValues as (a: Uint8Array) => Uint8Array).bind(globalThis.crypto);

export const REMOVED = ["TextDecoder", "WebAssembly", "Buffer", "structuredClone", "atob", "btoa", "URL", "URLSearchParams"];
for (const name of REMOVED) Object.defineProperty(g, name, { value: undefined, configurable: true, writable: true });
Object.defineProperty(g, "crypto", { value: Object.freeze({ getRandomValues }), configurable: true, writable: true });
g.__HERMES_SIMULATION__ = true;
