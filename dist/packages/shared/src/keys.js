import { isObject, isStringRecord, isStrings } from "./json.js";
// ../shared/src/keys.ts
function isSignatures(value) {
	return isObject(value) && Object.values(value).every(isStringRecord);
}
/** A one-time or fallback key: unsigned (a string) or signed. */
function isOneTimeKey(value) {
	return typeof value === "string" || isObject(value) && typeof value.key === "string" && isSignatures(value.signatures);
}
function isDeviceKeys(value) {
	return isObject(value) && typeof value.user_id === "string" && typeof value.device_id === "string" && isStrings(value.algorithms) && isStringRecord(value.keys) && isSignatures(value.signatures) && (value.unsigned === void 0 || isObject(value.unsigned));
}
function isCrossSigningKey(value) {
	return isObject(value) && typeof value.user_id === "string" && isStrings(value.usage) && isStringRecord(value.keys) && (value.signatures === void 0 || isSignatures(value.signatures));
}
export { isCrossSigningKey, isDeviceKeys, isOneTimeKey, isSignatures };

//# sourceMappingURL=keys.js.map