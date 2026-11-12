/**
 * Base64 without atob/btoa (missing on older Hermes, and they work on binary strings, not bytes).
 *
 * Matrix uses unpadded standard Base64 for keys, signatures and ciphertexts
 * (https://spec.matrix.org/v1.16/appendices/#unpadded-base64). Decoding accepts input with or
 * without padding, as the appendix asks, and also the URL-safe alphabet (used by some keys in
 * the wild, for example OAuth PKCE). Characters outside the alphabets are rejected rather than
 * skipped: a stray character in a key must not decode to a different key.
 */
export declare function encodeBase64(bytes: Uint8Array, opts?: {
  pad?: boolean;
  urlSafe?: boolean;
}): string;
export declare function decodeBase64(input: string): Uint8Array;
//# sourceMappingURL=base64.d.ts.map