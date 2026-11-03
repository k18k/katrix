import { type CryptoPrimitives } from "./primitives.ts";
/**
 * The default primitives, on @noble/curves, @noble/ciphers and @noble/hashes: audited, pure
 * JavaScript (no WebAssembly, no WebCrypto), so they run unchanged on Hermes.
 *
 * `randomValues` defaults to crypto.getRandomValues. It is checked when the primitives are
 * created, not on first use: a client must not start without a secure random source.
 */
export declare function nobleCryptoPrimitives(opts?: {
    randomValues?: (array: Uint8Array) => Uint8Array;
}): CryptoPrimitives;
