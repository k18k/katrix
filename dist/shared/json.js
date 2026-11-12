// ../shared/src/json.ts
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringRecord(value) {
	return isObject(value) && Object.values(value).every((v) => typeof v === "string");
}
export { isObject, isStringRecord };

//# sourceMappingURL=json.js.map