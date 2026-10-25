/**
 * Base64 without atob/btoa (missing on older Hermes, and they work on binary strings, not bytes).
 *
 * Matrix uses unpadded standard Base64 for keys, signatures and ciphertexts
 * (https://spec.matrix.org/v1.16/appendices/#unpadded-base64). Decoding accepts input with or
 * without padding, as the appendix asks, and also the URL-safe alphabet (used by some keys in
 * the wild, for example OAuth PKCE). Characters outside the alphabets are rejected rather than
 * skipped: a stray character in a key must not decode to a different key.
 */

const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) {
  DECODE[STD.charCodeAt(i)] = i;
  DECODE[URL_SAFE.charCodeAt(i)] = i;
}

export function encodeBase64(bytes: Uint8Array, opts: { pad?: boolean; urlSafe?: boolean } = {}): string {
  const alphabet = opts.urlSafe ? URL_SAFE : STD;
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + (opts.pad ? "==" : "");
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + (opts.pad ? "=" : "");
  }
  return out;
}

export class Base64Error extends Error {
  constructor() {
    // The input is not echoed: it may be key material.
    super("Invalid Base64");
    this.name = "Base64Error";
  }
}

export function decodeBase64(input: string): Uint8Array {
  let end = input.length;
  if (end % 4 === 0 && end > 0) {
    if (input[end - 1] === "=") end--;
    if (input[end - 1] === "=") end--;
  }
  if (end % 4 === 1) throw new Base64Error();
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let o = 0,
    acc = 0,
    bits = 0;
  for (let i = 0; i < end; i++) {
    const c = input.charCodeAt(i);
    const v = c < 128 ? DECODE[c] : -1;
    if (v < 0) throw new Base64Error();
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  // Leftover bits are ignored, not required to be zero: the spec's own test vector (the signing
  // key seed in https://spec.matrix.org/v1.16/appendices/#json-signing) has non-zero ones, and so
  // do keys from other implementations. Keys are compared as decoded bytes where it matters.
  return out;
}
