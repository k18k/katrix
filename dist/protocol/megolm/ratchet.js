import { concatBytes } from "../../shared/bytes.js";
import { encodeUtf8 } from "../../shared/utf8.js";
// src/protocol/megolm/ratchet.ts
/**
* The Megolm ratchet (megolm.md, "The Megolm ratchet algorithm"): four 256-bit parts R_0…R_3 and
* a 32-bit counter i. R_j is rehashed every 2^(8·(3-j)) steps; rehashing part j also resets the
* parts after it from the new R_j. H_k(A) = HMAC-SHA-256(A, k) with the single byte k.
*
* Advancing to index n costs at most 4 × 255 hashes, however far n is: whole parts are skipped.
*/
const SEEDS = [
	Uint8Array.of(0),
	Uint8Array.of(1),
	Uint8Array.of(2),
	Uint8Array.of(3)
];
const KEYS_INFO = encodeUtf8("MEGOLM_KEYS");
function ratchetFromBytes(bytes, counter) {
	return {
		parts: [
			0,
			1,
			2,
			3
		].map((j) => bytes.slice(j * 32, j * 32 + 32)),
		counter: counter >>> 0
	};
}
function ratchetBytes(r) {
	return concatBytes(...r.parts);
}
function copyRatchet(r) {
	return {
		parts: r.parts.map((x) => x.slice()),
		counter: r.counter
	};
}
function rehash(p, r, from, to) {
	r.parts[to] = p.hmacSha256(r.parts[from], SEEDS[to]);
}
/** One step: i → i+1. */
function advance(p, r) {
	r.counter = r.counter + 1 >>> 0;
	let h = 0;
	let mask = 16777215;
	while (h < 4) {
		if (!(r.counter & mask)) break;
		h++;
		mask >>>= 8;
	}
	for (let i = 3; i >= h; i--) rehash(p, r, h, i);
}
/** Jump forward to `index` (≥ the current counter; the caller checks). */
function advanceTo(p, r, index) {
	index = index >>> 0;
	for (let j = 0; j < 4; j++) {
		const shift = (3 - j) * 8;
		const mask = 4294967295 << shift >>> 0;
		let steps = (index >>> shift) - (r.counter >>> shift) & 255;
		if (steps === 0) continue;
		while (steps > 1) {
			rehash(p, r, j, j);
			steps--;
		}
		for (let k = 3; k >= j; k--) rehash(p, r, j, k);
		r.counter = (index & mask) >>> 0;
	}
}
/** AES_KEY ‖ HMAC_KEY ‖ AES_IV = HKDF(0, R_i, "MEGOLM_KEYS", 80). */
function messageKeys(p, r) {
	const okm = p.hkdfSha256(ratchetBytes(r), void 0, KEYS_INFO, 80);
	return {
		aes: okm.slice(0, 32),
		mac: okm.slice(32, 64),
		iv: okm.slice(64, 80)
	};
}
export { advance, advanceTo, copyRatchet, messageKeys, ratchetBytes, ratchetFromBytes };

//# sourceMappingURL=ratchet.js.map