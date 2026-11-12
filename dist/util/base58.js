// src/util/base58.ts
/**
* Base58 with the Bitcoin alphabet, for secret storage recovery keys
* (https://spec.matrix.org/v1.19/client-server-api/#key-representation). Inputs are short (35
* bytes), so the quadratic big-number conversion is fine.
*/
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));
function encodeBase58(bytes) {
	const digits = [];
	for (const byte of bytes) {
		let carry = byte;
		for (let i = 0; i < digits.length; i++) {
			carry += digits[i] << 8;
			digits[i] = carry % 58;
			carry = carry / 58 | 0;
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = carry / 58 | 0;
		}
	}
	let out = "";
	for (const byte of bytes) {
		if (byte !== 0) break;
		out += ALPHABET[0];
	}
	for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
	return out;
}
/** Throws on a character outside the alphabet. */
function decodeBase58(text) {
	const bytes = [];
	for (const c of text) {
		const value = INDEX.get(c);
		if (value === void 0) throw new Error("Invalid base58 character");
		let carry = value;
		for (let i = 0; i < bytes.length; i++) {
			carry += bytes[i] * 58;
			bytes[i] = carry & 255;
			carry >>= 8;
		}
		while (carry > 0) {
			bytes.push(carry & 255);
			carry >>= 8;
		}
	}
	let zeros = 0;
	for (const c of text) {
		if (c !== ALPHABET[0]) break;
		zeros++;
	}
	const out = new Uint8Array(zeros + bytes.length);
	for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i];
	return out;
}
export { decodeBase58, encodeBase58 };

//# sourceMappingURL=base58.js.map