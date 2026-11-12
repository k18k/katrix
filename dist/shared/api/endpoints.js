// ../shared/src/api/endpoints.ts
/** The absolute path of an endpoint's path template: under /_matrix/client unless it is absolute already. */
function endpointUrlPath(template) {
	return template.startsWith("/_matrix/") || template.startsWith("/.well-known/") ? template : `/_matrix/client${template}`;
}
/** "/v3/rooms/:roomId/leave" with { roomId } → "/v3/rooms/!a%3Ab/leave". Each value is one path segment. */
function endpointPath(template, params) {
	return template.replace(/:([A-Za-z]+)/g, (_, name) => {
		const value = params[name];
		if (value === void 0) throw new Error(`Missing path parameter ${name}`);
		return encodeURIComponent(value);
	});
}
export { endpointPath, endpointUrlPath };

//# sourceMappingURL=endpoints.js.map