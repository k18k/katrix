import type { CryptoPrimitives } from "../../crypto/primitives.ts";
import { concatBytes } from "../../util/bytes.ts";
import { encodeUtf8 } from "../../util/utf8.ts";

/**
 * The Megolm ratchet (megolm.md, "The Megolm ratchet algorithm"): four 256-bit parts R_0…R_3 and
 * a 32-bit counter i. R_j is rehashed every 2^(8·(3-j)) steps; rehashing part j also resets the
 * parts after it from the new R_j. H_k(A) = HMAC-SHA-256(A, k) with the single byte k.
 *
 * Advancing to index n costs at most 4 × 255 hashes, however far n is: whole parts are skipped.
 */

const SEEDS = [Uint8Array.of(0), Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3)];
const KEYS_INFO = encodeUtf8("MEGOLM_KEYS");

export const RATCHET_LENGTH = 128;

export interface MegolmRatchet {
  /** R_0…R_3. */
  parts: Uint8Array[];
  counter: number;
}

export function ratchetFromBytes(bytes: Uint8Array, counter: number): MegolmRatchet {
  return { parts: [0, 1, 2, 3].map((j) => bytes.slice(j * 32, j * 32 + 32)), counter: counter >>> 0 };
}

export function ratchetBytes(r: MegolmRatchet): Uint8Array {
  return concatBytes(...r.parts);
}

export function copyRatchet(r: MegolmRatchet): MegolmRatchet {
  return { parts: r.parts.map((x) => x.slice()), counter: r.counter };
}

function rehash(p: CryptoPrimitives, r: MegolmRatchet, from: number, to: number): void {
  r.parts[to] = p.hmacSha256(r.parts[from], SEEDS[to]);
}

/** One step: i → i+1. */
export function advance(p: CryptoPrimitives, r: MegolmRatchet): void {
  r.counter = (r.counter + 1) >>> 0;
  // The lowest-numbered part whose period divides the new counter is rehashed, with all after it.
  let h = 0;
  let mask = 0x00ffffff;
  while (h < 4) {
    if (!(r.counter & mask)) break;
    h++;
    mask >>>= 8;
  }
  // Parts after h first: they are derived from the old R_h, then R_h from itself.
  for (let i = 3; i >= h; i--) rehash(p, r, h, i);
}

/** Jump forward to `index` (≥ the current counter; the caller checks). */
export function advanceTo(p: CryptoPrimitives, r: MegolmRatchet, index: number): void {
  index = index >>> 0;
  for (let j = 0; j < 4; j++) {
    const shift = (3 - j) * 8;
    const mask = (0xffffffff << shift) >>> 0;
    // How often part j has to be rehashed; the byte mask handles wraparound of the lower bits.
    let steps = ((index >>> shift) - (r.counter >>> shift)) & 0xff;
    if (steps === 0) continue;
    // All but the last step only move R_j itself…
    while (steps > 1) {
      rehash(p, r, j, j);
      steps--;
    }
    // …the last one also resets the parts after it.
    for (let k = 3; k >= j; k--) rehash(p, r, j, k);
    r.counter = (index & mask) >>> 0;
  }
}

/** AES_KEY ‖ HMAC_KEY ‖ AES_IV = HKDF(0, R_i, "MEGOLM_KEYS", 80). */
export function messageKeys(p: CryptoPrimitives, r: MegolmRatchet) {
  const okm = p.hkdfSha256(ratchetBytes(r), undefined, KEYS_INFO, 80);
  return { aes: okm.slice(0, 32), mac: okm.slice(32, 64), iv: okm.slice(64, 80) };
}
