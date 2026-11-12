import { decodeBase64, encodeBase64 } from "../shared/base64.js";
import { concatBytes, constantTimeEqual } from "../shared/bytes.js";
import { encodeUtf8 } from "../shared/utf8.js";
// src/e2ee/secret-box.ts
/**
* Secrets this device keeps at rest (cross-signing private keys, the backup key), sealed with the
* pickle key like the Olm and Megolm pickles: AES-256-CTR and HMAC-SHA-256 under keys derived
* from it per secret name. Without a pickle key they are stored as they are, and the storage
* adapter is the only protection, as for the pickles.
*/
var SecretBox = class {
	primitives;
	key;
	constructor(primitives, key) {
		this.primitives = primitives;
		this.key = key;
	}
	keys(name) {
		const okm = this.primitives.hkdfSha256(this.key, void 0, encodeUtf8(`katrix secret ${name}`), 64);
		return {
			aes: okm.subarray(0, 32),
			mac: okm.subarray(32)
		};
	}
	seal(name, secret) {
		if (!this.key) return `plain:${encodeBase64(secret)}`;
		const { aes, mac } = this.keys(name);
		const iv = this.primitives.randomBytes(16);
		const ciphertext = this.primitives.aes256Ctr(aes, iv, secret);
		const tag = this.primitives.hmacSha256(mac, concatBytes(iv, ciphertext));
		return `v1:${encodeBase64(concatBytes(iv, ciphertext, tag))}`;
	}
	/** Throws when the sealed value was made with another pickle key or was changed. */
	open(name, sealed) {
		if (sealed.startsWith("plain:")) {
			if (this.key) throw new Error("A secret was stored without the pickle key");
			return decodeBase64(sealed.slice(6));
		}
		if (!sealed.startsWith("v1:") || !this.key) throw new Error("A stored secret cannot be opened without its pickle key");
		const bytes = decodeBase64(sealed.slice(3));
		if (bytes.length < 48) throw new Error("A stored secret is damaged");
		const iv = bytes.subarray(0, 16);
		const ciphertext = bytes.subarray(16, bytes.length - 32);
		const { aes, mac } = this.keys(name);
		if (!constantTimeEqual(this.primitives.hmacSha256(mac, concatBytes(iv, ciphertext)), bytes.subarray(bytes.length - 32))) throw new Error("A stored secret does not match the pickle key");
		return this.primitives.aes256Ctr(aes, iv, ciphertext);
	}
};
export { SecretBox };

//# sourceMappingURL=secret-box.js.map