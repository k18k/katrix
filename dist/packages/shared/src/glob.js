// ../shared/src/glob.ts
/**
* Glob matching (`*` = any run of characters, `?` = one character) in linear time.
*
* Security fix (https://github.com/k18k/katrix/issues/2 — ReDoS, CWE-1333): globs from untrusted input (m.room.server_acl entries from
* room state, MSC4155 invite rules from account data, event filters from clients) used to be
* compiled to regular expressions with `.*`. A pattern such as `****************!` made the
* regex engine backtrack exponentially: 16 asterisks blocked the event loop for ~110 s, so a
* room ACL could hang the whole homeserver, again after every restart. This matcher never
* backtracks more than once per character (classic two-pointer wildcard matching).
*/
function globMatch(pattern, value, opts = {}) {
	const p = opts.caseInsensitive ? pattern.toLowerCase() : pattern;
	const v = opts.caseInsensitive ? value.toLowerCase() : value;
	const anyOne = opts.questionMark ?? true;
	let pi = 0, vi = 0;
	let star = -1, mark = 0;
	while (vi < v.length) if (pi < p.length && (p[pi] === v[vi] || anyOne && p[pi] === "?")) {
		pi++;
		vi++;
	} else if (pi < p.length && p[pi] === "*") {
		star = ++pi;
		mark = vi;
	} else if (star !== -1) {
		pi = star;
		vi = ++mark;
	} else return false;
	while (pi < p.length && p[pi] === "*") pi++;
	return pi === p.length;
}
const isWordChar = (c) => c !== void 0 && /[A-Za-z0-9_]/.test(c);
/**
* Whether `pattern` (a glob) matches some run of `value` that starts and ends on a word boundary,
* as push rules match `content.body`. Case-insensitive.
*
* Security fix (https://github.com/k18k/katrix/issues/2 — ReDoS, CWE-1333): push rule patterns are set by any user and were compiled to
* `(^|\W)…(\W|$)` regexes with `.*?`, then run against every message in the user's rooms, so one
* account could hang the server. This simulates the glob as an automaton instead: the cost is
* O(value length × pattern length) whatever the input, with no backtracking.
*/
function globSearchWords(pattern, value) {
	const p = pattern.toLowerCase();
	const v = value.toLowerCase();
	const m = p.length;
	let active = new Uint8Array(m + 1);
	const close = (set) => {
		for (let k = 0; k < m; k++) if (set[k] && p[k] === "*") set[k + 1] = 1;
	};
	for (let i = 0; i <= v.length; i++) {
		if (!isWordChar(v[i - 1])) active[0] = 1;
		close(active);
		if (active[m] && !isWordChar(v[i])) return true;
		if (i === v.length) break;
		const next = new Uint8Array(m + 1);
		const c = v[i];
		for (let k = 0; k < m; k++) {
			if (!active[k]) continue;
			if (p[k] === "*") next[k] = 1;
			else if (p[k] === "?" || p[k] === c) next[k + 1] = 1;
		}
		active = next;
	}
	return false;
}
export { globMatch, globSearchWords };

//# sourceMappingURL=glob.js.map