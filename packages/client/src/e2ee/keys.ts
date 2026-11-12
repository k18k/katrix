import type { KeyObject } from "@katrix/shared";
import type { E2EEProtocol, OlmAccount } from "../protocol/protocol.ts";
import { signingJson } from "@katrix/shared";

export const OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";
export const MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2";

/** Add our device's signature to `obj` (https://spec.matrix.org/v1.16/appendices/#signing-json). */
export function signObject<T extends Record<string, unknown>>(
  account: OlmAccount,
  userId: string,
  deviceId: string,
  obj: T,
): T & { signatures: Record<string, Record<string, string>> } {
  const signature = account.sign(signingJson(obj));
  const existing = (obj.signatures ?? {}) as Record<string, Record<string, string>>;
  return { ...obj, signatures: { ...existing, [userId]: { ...existing[userId], [`ed25519:${deviceId}`]: signature } } };
}

/** Whether `obj` carries a valid signature by `userId`'s key `ed25519:<keyId>`. Never throws. */
export function verifyObject(
  protocol: E2EEProtocol,
  obj: Record<string, unknown>,
  userId: string,
  keyId: string,
  publicKey: string,
): boolean {
  const sig = (obj.signatures as Record<string, Record<string, unknown>> | undefined)?.[userId]?.[`ed25519:${keyId}`];
  if (typeof sig !== "string") return false;
  try {
    return protocol.verifyEd25519(publicKey, signingJson(obj), sig);
  } catch {
    // Canonical JSON refuses floats and the like: such an object cannot carry a valid signature.
    return false;
  }
}

export function deviceKeysObject(account: OlmAccount, userId: string, deviceId: string) {
  const ik = account.identityKeys();
  return signObject(account, userId, deviceId, {
    user_id: userId,
    device_id: deviceId,
    algorithms: [OLM_ALGORITHM, MEGOLM_ALGORITHM],
    keys: { [`curve25519:${deviceId}`]: ik.curve25519, [`ed25519:${deviceId}`]: ik.ed25519 },
  });
}

/** The unpublished one-time and fallback keys, signed, as /keys/upload takes them. */
export function oneTimeKeysObject(account: OlmAccount, userId: string, deviceId: string) {
  const oneTime: Record<string, KeyObject> = {};
  for (const [id, key] of Object.entries(account.oneTimeKeys()))
    oneTime[`signed_curve25519:${id}`] = signObject(account, userId, deviceId, { key });
  const fallback: Record<string, KeyObject> = {};
  for (const [id, key] of Object.entries(account.fallbackKey()))
    fallback[`signed_curve25519:${id}`] = signObject(account, userId, deviceId, { key, fallback: true });
  return { oneTime, fallback };
}
