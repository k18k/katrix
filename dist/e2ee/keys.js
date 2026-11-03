import { signingJson } from "../util/canonical-json.js";
export const OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";
export const MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2";
/** Add our device's signature to `obj` (https://spec.matrix.org/v1.16/appendices/#signing-json). */
export function signObject(account, userId, deviceId, obj) {
    const signature = account.sign(signingJson(obj));
    const existing = (obj.signatures ?? {});
    return { ...obj, signatures: { ...existing, [userId]: { ...existing[userId], [`ed25519:${deviceId}`]: signature } } };
}
/** Whether `obj` carries a valid signature by `userId`'s key `ed25519:<keyId>`. Never throws. */
export function verifyObject(protocol, obj, userId, keyId, publicKey) {
    const sig = obj.signatures?.[userId]?.[`ed25519:${keyId}`];
    if (typeof sig !== "string")
        return false;
    try {
        return protocol.verifyEd25519(publicKey, signingJson(obj), sig);
    }
    catch {
        // Canonical JSON refuses floats and the like: such an object cannot carry a valid signature.
        return false;
    }
}
export function deviceKeysObject(account, userId, deviceId) {
    const ik = account.identityKeys();
    return signObject(account, userId, deviceId, {
        user_id: userId,
        device_id: deviceId,
        algorithms: [OLM_ALGORITHM, MEGOLM_ALGORITHM],
        keys: { [`curve25519:${deviceId}`]: ik.curve25519, [`ed25519:${deviceId}`]: ik.ed25519 },
    });
}
/** The unpublished one-time and fallback keys, signed, as /keys/upload takes them. */
export function oneTimeKeysObject(account, userId, deviceId) {
    const oneTime = {};
    for (const [id, key] of Object.entries(account.oneTimeKeys()))
        oneTime[`signed_curve25519:${id}`] = signObject(account, userId, deviceId, { key });
    const fallback = {};
    for (const [id, key] of Object.entries(account.fallbackKey()))
        fallback[`signed_curve25519:${id}`] = signObject(account, userId, deviceId, { key, fallback: true });
    return { oneTime, fallback };
}
