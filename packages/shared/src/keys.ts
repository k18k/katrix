import type { CrossSigningKey, DeviceKeys, KeyObject, Signatures } from "./api/keys.ts";
import { isObject, isStringRecord, isStrings } from "./json.ts";

// Checks for end-to-end encryption keys that arrive from another server or a client, so that
// what is handed on has the shape the spec types (api/keys.ts) promise.

export function isSignatures(value: unknown): value is Signatures {
  return isObject(value) && Object.values(value).every(isStringRecord);
}

/** A one-time or fallback key: unsigned (a string) or signed. */
export function isOneTimeKey(value: unknown): value is KeyObject | string {
  return typeof value === "string" || (isObject(value) && typeof value.key === "string" && isSignatures(value.signatures));
}

export function isDeviceKeys(value: unknown): value is DeviceKeys {
  return (
    isObject(value) &&
    typeof value.user_id === "string" &&
    typeof value.device_id === "string" &&
    isStrings(value.algorithms) &&
    isStringRecord(value.keys) &&
    isSignatures(value.signatures) &&
    (value.unsigned === undefined || isObject(value.unsigned))
  );
}

export function isCrossSigningKey(value: unknown): value is CrossSigningKey {
  return (
    isObject(value) &&
    typeof value.user_id === "string" &&
    isStrings(value.usage) &&
    isStringRecord(value.keys) &&
    (value.signatures === undefined || isSignatures(value.signatures))
  );
}
