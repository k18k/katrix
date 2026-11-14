// ../shared/src/ids.ts
/**
* Matrix identifiers (https://spec.matrix.org/v1.16/appendices/#identifier-grammar): the checks
* the server applies to what it receives, and the client to what it is given.
*/
const LOCALPART_RE = /^[a-z0-9._=\-/+]+$/;
function parseId(id, sigil) {
	if (typeof id !== "string" || !id.startsWith(sigil)) return null;
	const idx = id.indexOf(":");
	if (idx < 2) return null;
	return {
		localpart: id.slice(1, idx),
		server: id.slice(idx + 1)
	};
}
/** Server name grammar: DNS name, IPv4 or bracketed IPv6, with an optional port. */
const SERVER_NAME_RE = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;
function isValidServerName(name) {
	return name.length > 0 && name.length <= 255 && SERVER_NAME_RE.test(name);
}
function isValidUserId(id) {
	if (typeof id !== "string" || id.length > 255) return false;
	const parsed = parseId(id, "@");
	return !!parsed && isValidServerName(parsed.server);
}
function isValidRoomId(id) {
	return typeof id === "string" && /^![^\s:]+(:[^\s]+)?$/.test(id);
}
function isValidAlias(id) {
	return typeof id === "string" && id.length <= 255 && !!parseId(id, "#");
}
export { LOCALPART_RE, isValidAlias, isValidRoomId, isValidServerName, isValidUserId, parseId };

//# sourceMappingURL=ids.js.map