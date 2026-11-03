/**
 * UTF-8 without TextEncoder/TextDecoder: Hermes has no TextDecoder, and decrypted plaintexts must
 * be decoded strictly (invalid UTF-8 is an error, not U+FFFD), which TextDecoder only does with
 * `fatal: true` anyway.
 */
export declare function encodeUtf8(s: string): Uint8Array;
export declare class Utf8Error extends Error {
    constructor();
}
/** Strict decoding: overlong forms, surrogates, code points above U+10FFFF and truncation throw. */
export declare function decodeUtf8(bytes: Uint8Array): string;
