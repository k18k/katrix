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
export declare function globMatch(pattern: string, value: string, opts?: {
    caseInsensitive?: boolean;
    questionMark?: boolean;
}): boolean;
/**
 * Whether `pattern` (a glob) matches some run of `value` that starts and ends on a word boundary,
 * as push rules match `content.body`. Case-insensitive.
 *
 * Security fix (https://github.com/k18k/katrix/issues/2 — ReDoS, CWE-1333): push rule patterns are set by any user and were compiled to
 * `(^|\W)…(\W|$)` regexes with `.*?`, then run against every message in the user's rooms, so one
 * account could hang the server. This simulates the glob as an automaton instead: the cost is
 * O(value length × pattern length) whatever the input, with no backtracking.
 */
export declare function globSearchWords(pattern: string, value: string): boolean;
