// ../shared/src/canonical-json.ts
/**
* Canonical JSON (https://spec.matrix.org/v1.16/appendices/#canonical-json): keys sorted by
* Unicode code point, no insignificant whitespace, integers only, in [-(2^53)+1, 2^53-1].
* It is what Ed25519 signatures over JSON (device keys, one-time keys) cover.
*/
var CanonicalJsonError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "CanonicalJsonError";
	}
};
/**
* Sort by code point, not by UTF-16 code unit as Array.prototype.sort does: the two differ when
* one key has a character above U+FFFF (a surrogate pair, 0xD800…) and the other one in
* U+E000…U+FFFF.
*
* Fix (https://github.com/k18k/katrix/issues/25): the server sorted keys by UTF-16 code unit, so
* for such keys its hashes and signatures did not match other servers'.
*/
function compareCodePoints(a, b) {
	const ia = a[Symbol.iterator]();
	const ib = b[Symbol.iterator]();
	for (;;) {
		const x = ia.next();
		const y = ib.next();
		if (x.done) return y.done ? 0 : -1;
		if (y.done) return 1;
		const cx = x.value.codePointAt(0);
		const cy = y.value.codePointAt(0);
		if (cx !== cy) return cx - cy;
	}
}
const MAX_SAFE = 2 ** 53 - 1;
function write(value, out) {
	if (value === null) out.push("null");
	else if (typeof value === "boolean") out.push(value ? "true" : "false");
	else if (typeof value === "number") {
		if (!Number.isInteger(value) || Math.abs(value) > MAX_SAFE) throw new CanonicalJsonError("Canonical JSON allows only safe integers");
		out.push(String(value === 0 ? 0 : value));
	} else if (typeof value === "string") out.push(JSON.stringify(value));
	else if (Array.isArray(value)) {
		out.push("[");
		value.forEach((v, i) => {
			if (i > 0) out.push(",");
			write(v === void 0 ? null : v, out);
		});
		out.push("]");
	} else if (typeof value === "object") {
		const keys = Object.keys(value).filter((k) => value[k] !== void 0).sort(compareCodePoints);
		out.push("{");
		keys.forEach((k, i) => {
			if (i > 0) out.push(",");
			out.push(JSON.stringify(k), ":");
			write(value[k], out);
		});
		out.push("}");
	} else throw new CanonicalJsonError(`Canonical JSON cannot encode a ${typeof value}`);
}
function canonicalJson(value) {
	const out = [];
	write(value, out);
	return out.join("");
}
/** The canonical JSON that a signature covers: the object without `signatures` and `unsigned`. */
function signingJson(value) {
	const { signatures: _s, unsigned: _u, ...rest } = value;
	return canonicalJson(rest);
}
export { CanonicalJsonError, canonicalJson, signingJson };

//# sourceMappingURL=canonical-json.js.map