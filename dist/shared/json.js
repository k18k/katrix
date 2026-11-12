// ../shared/src/json.ts
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringOrUndefined(value) {
	return typeof value === "string" ? value : void 0;
}
function isStrings(value) {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}
export { isObject, isStrings, stringOrUndefined };

//# sourceMappingURL=json.js.map