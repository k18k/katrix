// src/util/query.ts
function encodeQuery(params) {
	const parts = [];
	for (const [k, v] of Object.entries(params)) {
		if (v === void 0 || v === null) continue;
		const values = Array.isArray(v) ? v : [String(v)];
		for (const one of values) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(one)}`);
	}
	return parts.join("&");
}
/** Parse the query of a URL (for example an OAuth redirect) into its first value per key. */
function parseQuery(url) {
	const q = url.includes("?") ? url.slice(url.indexOf("?") + 1) : url;
	const query = q.includes("#") ? q.slice(0, q.indexOf("#")) : q;
	const out = {};
	for (const part of query.split("&")) {
		if (!part) continue;
		const eq = part.indexOf("=");
		const k = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, " "));
		const v = eq < 0 ? "" : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
		if (!(k in out)) out[k] = v;
	}
	return out;
}
export { encodeQuery, parseQuery };

//# sourceMappingURL=query.js.map