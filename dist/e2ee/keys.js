import { signingJson } from "../shared/canonical-json.js";
// src/e2ee/keys.ts
const OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";
const MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2";
/** Add our device's signature to `obj` (https://spec.matrix.org/v1.16/appendices/#signing-json). */
function signObject(account, userId, deviceId, obj) {
	const signature = account.sign(signingJson(obj));
	const existing = ("signatures" in obj ? obj.signatures : void 0) ?? {};
	return {
		...obj,
		signatures: {
			...existing,
			[userId]: {
				...existing[userId],
				[`ed25519:${deviceId}`]: signature
			}
		}
	};
}
/** Whether `obj` carries a valid signature by `userId`'s key `ed25519:<keyId>`. Never throws. */
function verifyObject(protocol, obj, userId, keyId, publicKey) {
	const sig = ("signatures" in obj ? obj.signatures : void 0)?.[userId]?.[`ed25519:${keyId}`];
	if (typeof sig !== "string") return false;
	try {
		return protocol.verifyEd25519(publicKey, signingJson(obj), sig);
	} catch {
		return false;
	}
}
function deviceKeysObject(account, userId, deviceId) {
	const ik = account.identityKeys();
	return signObject(account, userId, deviceId, {
		user_id: userId,
		device_id: deviceId,
		algorithms: [OLM_ALGORITHM, MEGOLM_ALGORITHM],
		keys: {
			[`curve25519:${deviceId}`]: ik.curve25519,
			[`ed25519:${deviceId}`]: ik.ed25519
		}
	});
}
/** The unpublished one-time and fallback keys, signed, as /keys/upload takes them. */
function oneTimeKeysObject(account, userId, deviceId) {
	const oneTime = {};
	for (const [id, key] of Object.entries(account.oneTimeKeys())) oneTime[`signed_curve25519:${id}`] = signObject(account, userId, deviceId, { key });
	const fallback = {};
	for (const [id, key] of Object.entries(account.fallbackKey())) fallback[`signed_curve25519:${id}`] = signObject(account, userId, deviceId, {
		key,
		fallback: true
	});
	return {
		oneTime,
		fallback
	};
}
export { MEGOLM_ALGORITHM, OLM_ALGORITHM, deviceKeysObject, oneTimeKeysObject, signObject, verifyObject };

//# sourceMappingURL=keys.js.map