import { canonicalJson } from "../packages/shared/src/canonical-json.js";
import { isObject } from "../packages/shared/src/json.js";
import { isSignatures } from "../packages/shared/src/keys.js";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomInt, scrypt, sign, timingSafeEqual, verify } from "node:crypto";
import { promisify } from "node:util";
// src/core/crypto.ts
const scryptAsync = promisify(scrypt);
function unpaddedBase64(buf) {
	return Buffer.from(buf).toString("base64").replace(/=+$/, "");
}
function urlSafeBase64(buf) {
	return unpaddedBase64(buf).replace(/\+/g, "-").replace(/\//g, "_");
}
function randomString(length) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	let out = "";
	for (let i = 0; i < length; i++) out += alphabet[randomInt(52)];
	return out;
}
function randomToken(bytes = 32) {
	return urlSafeBase64(randomBytes(bytes));
}
function sha256(data) {
	return createHash("sha256").update(data).digest();
}
async function hashPassword(password) {
	const salt = randomBytes(16);
	const hash = await scryptAsync(password.normalize("NFKC"), salt, 64);
	return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}
async function verifyPassword(password, stored) {
	const [scheme, saltB64, hashB64] = stored.split("$");
	if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
	const expected = Buffer.from(hashB64, "base64");
	const actual = await scryptAsync(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length);
	return timingSafeEqual(expected, actual);
}
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function loadSigningKey(keyId, seed) {
	let privateKey;
	if (seed) {
		const raw = Buffer.from(seed, "base64");
		privateKey = createPrivateKey({
			key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]),
			format: "der",
			type: "pkcs8"
		});
	} else privateKey = generateKeyPairSync("ed25519").privateKey;
	const der = privateKey.export({
		format: "der",
		type: "pkcs8"
	});
	const rawSeed = der.subarray(der.length - 32);
	const spki = createPublicKey(privateKey).export({
		format: "der",
		type: "spki"
	});
	const rawPub = spki.subarray(spki.length - 32);
	return {
		keyId,
		privateKey,
		publicKeyBase64: unpaddedBase64(rawPub),
		seed: unpaddedBase64(rawSeed)
	};
}
/** Sign a JSON object in place according to the Matrix signing algorithm. */
function signJson(obj, serverName, key) {
	const { signatures, unsigned, ...rest } = { ...obj };
	const sig = unpaddedBase64(sign(null, Buffer.from(canonicalJson(rest)), key.privateKey));
	const merged = isSignatures(signatures) ? { ...signatures } : {};
	merged[serverName] = {
		...merged[serverName],
		[`ed25519:${key.keyId}`]: sig
	};
	return Object.assign(obj, { signatures: merged });
}
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** Decode unpadded (standard or URL-safe) base64. */
function decodeBase64(s) {
	return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function publicKeyFromBase64(key) {
	return createPublicKey({
		key: Buffer.concat([SPKI_ED25519_PREFIX, decodeBase64(key)]),
		format: "der",
		type: "spki"
	});
}
/** Verify one ed25519 signature on a JSON object (signatures/unsigned excluded). */
function verifyJsonSignature(obj, serverName, keyId, publicKey) {
	const { signatures, unsigned, ...rest } = { ...obj };
	const byServer = isObject(signatures) ? signatures[serverName] : void 0;
	const sig = isObject(byServer) ? byServer[keyId] : void 0;
	if (typeof sig !== "string") return false;
	try {
		return verify(null, Buffer.from(canonicalJson(rest)), publicKey, decodeBase64(sig));
	} catch {
		return false;
	}
}
export { decodeBase64, hashPassword, loadSigningKey, publicKeyFromBase64, randomString, randomToken, sha256, signJson, unpaddedBase64, urlSafeBase64, verifyJsonSignature, verifyPassword };

//# sourceMappingURL=crypto.js.map