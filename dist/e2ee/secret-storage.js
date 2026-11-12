import { Base64Error, decodeBase64, encodeBase64 } from "../shared/base64.js";
import { constantTimeEqual } from "../shared/bytes.js";
import { decodeUtf8, encodeUtf8 } from "../shared/utf8.js";
import { decodeBase58, encodeBase58 } from "../util/base58.js";
// src/e2ee/secret-storage.ts
/**
* Secret storage (https://spec.matrix.org/v1.19/client-server-api/#storage): secrets (the
* cross-signing private keys, the key backup's private key) encrypted in the user's account data
* with a key only the user has: a recovery key, or one derived from a passphrase.
*/
const SSSS_ALGORITHM = "m.secret_storage.v1.aes-hmac-sha2";
var SecretStorageError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.name = "SecretStorageError";
		this.code = code;
	}
};
const RECOVERY_KEY_PREFIX = [139, 1];
/** A 32-byte key as a recovery key (https://spec.matrix.org/v1.19/appendices/#cryptographic-key-representation). */
function encodeRecoveryKey(key) {
	const bytes = /* @__PURE__ */ new Uint8Array(35);
	bytes.set(RECOVERY_KEY_PREFIX, 0);
	bytes.set(key, 2);
	let parity = 0;
	for (let i = 0; i < 34; i++) parity ^= bytes[i];
	bytes[34] = parity;
	return encodeBase58(bytes).replace(/(.{4})(?!$)/g, "$1 ");
}
/** Whitespace is ignored; a wrong prefix, length, character or parity is refused. */
function decodeRecoveryKey(text) {
	let bytes;
	try {
		bytes = decodeBase58(text.replace(/\s+/g, ""));
	} catch {
		throw new SecretStorageError("BAD_RECOVERY_KEY", "The recovery key has an invalid character");
	}
	let parity = 0;
	for (const b of bytes) parity ^= b;
	if (bytes.length !== 35 || bytes[0] !== RECOVERY_KEY_PREFIX[0] || bytes[1] !== RECOVERY_KEY_PREFIX[1] || parity !== 0) throw new SecretStorageError("BAD_RECOVERY_KEY", "This is not a valid recovery key");
	return bytes.slice(2, 34);
}
const ZERO_SALT = /* @__PURE__ */ new Uint8Array(32);
function decode(value) {
	if (typeof value !== "string") throw new SecretStorageError("UNSUPPORTED", "Malformed encrypted secret");
	try {
		return decodeBase64(value);
	} catch (e) {
		if (e instanceof Base64Error) throw new SecretStorageError("UNSUPPORTED", "Malformed encrypted secret");
		throw e;
	}
}
/** m.secret_storage.v1.aes-hmac-sha2, as the spec describes it step by step. */
function encryptSecret(primitives, key, name, plaintext, iv) {
	const okm = primitives.hkdfSha256(key, ZERO_SALT, encodeUtf8(name), 64);
	const theIv = iv ?? primitives.randomBytes(16);
	theIv[8] &= 127;
	const ciphertext = primitives.aes256Ctr(okm.subarray(0, 32), theIv, plaintext);
	const mac = primitives.hmacSha256(okm.subarray(32), ciphertext);
	return {
		iv: encodeBase64(theIv),
		ciphertext: encodeBase64(ciphertext),
		mac: encodeBase64(mac)
	};
}
function decryptSecret(primitives, key, name, data) {
	const iv = decode(data.iv);
	const ciphertext = decode(data.ciphertext);
	const mac = decode(data.mac);
	if (iv.length !== 16) throw new SecretStorageError("UNSUPPORTED", "Malformed encrypted secret");
	const okm = primitives.hkdfSha256(key, ZERO_SALT, encodeUtf8(name), 64);
	if (!constantTimeEqual(primitives.hmacSha256(okm.subarray(32), ciphertext), mac)) throw new SecretStorageError("BAD_MAC", "The secret does not decrypt with this key");
	return primitives.aes256Ctr(okm.subarray(0, 32), iv, ciphertext);
}
var SecretStorage = class {
	primitives;
	accountData;
	constructor(primitives, accountData) {
		this.primitives = primitives;
		this.accountData = accountData;
	}
	async defaultKeyId() {
		const key = (await this.accountData.get("m.secret_storage.default_key"))?.key;
		return typeof key === "string" ? key : void 0;
	}
	async keyDescription(keyId) {
		const id = keyId ?? await this.defaultKeyId();
		if (!id) return void 0;
		const description = await this.accountData.get(`m.secret_storage.key.${id}`);
		return description ? {
			keyId: id,
			description
		} : void 0;
	}
	/**
	* Create a secret storage key, made the default unless `setDefault: false`. With a
	* passphrase, the key is derived from it (PBKDF2-SHA-512, 500 000 iterations, as other clients
	* use); either way the returned recovery key opens it too.
	*/
	async createKey(opts = {}) {
		let key;
		let passphrase;
		if (opts.passphrase !== void 0) {
			passphrase = {
				algorithm: "m.pbkdf2",
				salt: encodeBase64(this.primitives.randomBytes(24)),
				iterations: 5e5,
				bits: 256
			};
			key = this.deriveKey(opts.passphrase, passphrase);
		} else key = this.primitives.randomBytes(32);
		const keyId = encodeBase64(this.primitives.randomBytes(24), { urlSafe: true });
		const check = encryptSecret(this.primitives, key, "", /* @__PURE__ */ new Uint8Array(32));
		const description = {
			algorithm: SSSS_ALGORITHM,
			...opts.name !== void 0 ? { name: opts.name } : {},
			...passphrase ? { passphrase } : {},
			iv: check.iv,
			mac: check.mac
		};
		await this.accountData.set(`m.secret_storage.key.${keyId}`, { ...description });
		if (opts.setDefault !== false) await this.accountData.set("m.secret_storage.default_key", { key: keyId });
		return {
			keyId,
			key,
			recoveryKey: encodeRecoveryKey(key)
		};
	}
	deriveKey(passphrase, p) {
		if (p.algorithm !== "m.pbkdf2") throw new SecretStorageError("UNSUPPORTED", `Unsupported passphrase algorithm ${p.algorithm}`);
		if ((p.bits ?? 256) !== 256) throw new SecretStorageError("UNSUPPORTED", "Only 256-bit passphrase keys are supported");
		return this.primitives.pbkdf2Sha512(encodeUtf8(passphrase), encodeUtf8(p.salt), p.iterations, 32);
	}
	/** The key a passphrase stands for, by the key's description. */
	async keyFromPassphrase(passphrase, keyId) {
		const found = await this.keyDescription(keyId);
		if (!found?.description.passphrase) throw new SecretStorageError("NO_KEY", "The key has no passphrase");
		return this.deriveKey(passphrase, found.description.passphrase);
	}
	/** Whether `key` is the key with this ID (by its check MAC; a key description without one accepts any key). */
	async checkKey(key, keyId) {
		const found = await this.keyDescription(keyId);
		if (!found) throw new SecretStorageError("NO_KEY", "No such secret storage key");
		const d = found.description;
		if (d.algorithm !== "m.secret_storage.v1.aes-hmac-sha2") throw new SecretStorageError("UNSUPPORTED", `Unsupported secret storage algorithm ${d.algorithm}`);
		if (d.iv === void 0 || d.mac === void 0) return true;
		const check = encryptSecret(this.primitives, key, "", /* @__PURE__ */ new Uint8Array(32), decode(d.iv));
		return constantTimeEqual(decode(check.mac), decode(d.mac));
	}
	/** Encrypt a secret (a string, as the spec has them) under a key and store it in account data. */
	async store(name, secret, key, keyId) {
		const id = keyId ?? await this.defaultKeyId();
		if (!id) throw new SecretStorageError("NO_KEY", "No default secret storage key");
		if (!await this.checkKey(key, id)) throw new SecretStorageError("BAD_KEY", "That is not the secret storage key");
		const existing = (await this.accountData.get(name))?.encrypted;
		await this.accountData.set(name, { encrypted: {
			...typeof existing === "object" && existing ? existing : {},
			[id]: encryptSecret(this.primitives, key, name, encodeUtf8(secret))
		} });
	}
	/** A stored secret, decrypted; undefined when it is not stored under that key. */
	async get(name, key, keyId) {
		const id = keyId ?? await this.defaultKeyId();
		if (!id) throw new SecretStorageError("NO_KEY", "No default secret storage key");
		const data = ((await this.accountData.get(name))?.encrypted)?.[id];
		if (!data) return void 0;
		return decodeUtf8(decryptSecret(this.primitives, key, name, data));
	}
	/** The key IDs a secret is stored under. */
	async storedUnder(name) {
		const encrypted = (await this.accountData.get(name))?.encrypted;
		return typeof encrypted === "object" && encrypted !== null ? Object.keys(encrypted) : [];
	}
};
export { SSSS_ALGORITHM, SecretStorage, SecretStorageError, decodeRecoveryKey, decryptSecret, encodeRecoveryKey, encryptSecret };

//# sourceMappingURL=secret-storage.js.map