import { platformRandomValues } from "../platform.js";
import { CryptoPrimitiveError } from "./primitives.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { cbc, ctr } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
// src/crypto/noble.ts
/**
* The default primitives, on @noble/curves, @noble/ciphers and @noble/hashes: audited, pure
* JavaScript (no WebAssembly, no WebCrypto), so they run unchanged on Hermes.
*
* `randomValues` defaults to crypto.getRandomValues. It is checked when the primitives are
* created, not on first use: a client must not start without a secure random source.
*/
function nobleCryptoPrimitives(opts = {}) {
	const fill = opts.randomValues ?? platformRandomValues();
	if (!fill) throw new CryptoPrimitiveError("No secure random source: crypto.getRandomValues is missing (in React Native, import react-native-get-random-values first)");
	const randomBytes = (length) => {
		const out = new Uint8Array(length);
		for (let o = 0; o < length; o += 65536) fill(out.subarray(o, Math.min(length, o + 65536)));
		return out;
	};
	const len = (what, bytes, n) => {
		if (!(bytes instanceof Uint8Array) || bytes.length !== n) throw new CryptoPrimitiveError(`${what} must be ${n} bytes`);
	};
	return {
		randomBytes,
		sha256: (data) => sha256(data),
		hmacSha256: (key, data) => hmac(sha256, key, data),
		pbkdf2Sha512(password, salt, iterations, length) {
			if (!Number.isInteger(iterations) || iterations < 1) throw new CryptoPrimitiveError("PBKDF2 needs a positive iteration count");
			return pbkdf2(sha512, password, salt, {
				c: iterations,
				dkLen: length
			});
		},
		hkdfSha256: (ikm, salt, info, length) => hkdf(sha256, ikm, salt && salt.length > 0 ? salt : void 0, info, length),
		x25519GenerateKeyPair() {
			const secretKey = randomBytes(32);
			return {
				secretKey,
				publicKey: x25519.getPublicKey(secretKey)
			};
		},
		x25519PublicKey(secretKey) {
			len("X25519 secret key", secretKey, 32);
			return x25519.getPublicKey(secretKey);
		},
		x25519SharedSecret(secretKey, publicKey) {
			len("X25519 secret key", secretKey, 32);
			len("X25519 public key", publicKey, 32);
			try {
				return x25519.getSharedSecret(secretKey, publicKey);
			} catch {
				throw new CryptoPrimitiveError("Invalid X25519 public key");
			}
		},
		ed25519GenerateKeyPair() {
			const secretKey = randomBytes(32);
			return {
				secretKey,
				publicKey: ed25519.getPublicKey(secretKey)
			};
		},
		ed25519PublicKey(seed) {
			len("Ed25519 seed", seed, 32);
			return ed25519.getPublicKey(seed);
		},
		ed25519Sign(seed, message) {
			len("Ed25519 seed", seed, 32);
			return ed25519.sign(message, seed);
		},
		ed25519Verify(publicKey, message, signature) {
			if (publicKey.length !== 32 || signature.length !== 64) return false;
			try {
				return ed25519.verify(signature, message, publicKey, { zip215: false });
			} catch {
				return false;
			}
		},
		aes256CbcEncrypt(key, iv, plaintext) {
			len("AES-256 key", key, 32);
			len("AES-CBC IV", iv, 16);
			return cbc(key, iv).encrypt(plaintext);
		},
		aes256CbcDecrypt(key, iv, ciphertext) {
			len("AES-256 key", key, 32);
			len("AES-CBC IV", iv, 16);
			if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) throw new CryptoPrimitiveError("Invalid AES-CBC ciphertext length");
			try {
				return cbc(key, iv).decrypt(ciphertext);
			} catch {
				throw new CryptoPrimitiveError("Invalid AES-CBC padding");
			}
		},
		aes256Ctr(key, iv, data) {
			len("AES-256 key", key, 32);
			len("AES-CTR IV", iv, 16);
			return ctr(key, iv).encrypt(data);
		}
	};
}
export { nobleCryptoPrimitives };

//# sourceMappingURL=noble.js.map