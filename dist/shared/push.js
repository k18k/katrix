import { isObject } from "./json.js";
import { M, UNSTABLE } from "./m.js";
import { globMatch, globSearchWords } from "./glob.js";
// ../shared/src/push.ts
/**
* The kinds of push rules, in the order they are evaluated. `postcontent` is MSC4306's (thread
* subscriptions), between content and room rules.
*/
const PUSH_RULE_KINDS = [
	"override",
	"content",
	"postcontent",
	"room",
	"sender",
	"underride"
];
/** The server-default push rules of a user (https://spec.matrix.org/v1.19/client-server-api/#predefined-rules). */
function defaultPushRules(userId) {
	const localpart = userId.slice(1).split(":")[0];
	const notify = ["notify"];
	const sound = (s) => ({
		set_tweak: "sound",
		value: s
	});
	const highlight = { set_tweak: "highlight" };
	const r = (rule_id, conditions, actions, extra = {}) => ({
		rule_id,
		default: true,
		enabled: true,
		actions,
		...conditions ? { conditions } : {},
		...extra
	});
	const em = (key, pattern) => ({
		kind: "event_match",
		key,
		pattern
	});
	const ep = (key, value) => ({
		kind: "event_property_is",
		key,
		value
	});
	return {
		override: [
			r(M.RULE.MASTER, [], [], { enabled: false }),
			r(M.RULE.SUPPRESS_NOTICES, [em("content.msgtype", M.NOTICE)], []),
			r(M.RULE.INVITE_FOR_ME, [
				em("type", M.ROOM.MEMBER),
				em("content.membership", "invite"),
				em("state_key", userId)
			], [...notify, sound("default")]),
			r(M.RULE.MEMBER_EVENT, [em("type", M.ROOM.MEMBER)], []),
			r(M.RULE.IS_USER_MENTION, [{
				kind: "event_property_contains",
				key: "content.m\\.mentions.user_ids",
				value: userId
			}], [
				...notify,
				sound("default"),
				highlight
			]),
			r(M.RULE.CONTAINS_DISPLAY_NAME, [{ kind: "contains_display_name" }], [
				...notify,
				sound("default"),
				highlight
			]),
			r(M.RULE.IS_ROOM_MENTION, [ep("content.m\\.mentions.room", true), {
				kind: "sender_notification_permission",
				key: "room"
			}], [...notify, highlight]),
			r(M.RULE.ROOMNOTIF, [em("content.body", "@room"), {
				kind: "sender_notification_permission",
				key: "room"
			}], [...notify, highlight]),
			r(M.RULE.TOMBSTONE, [em("type", M.ROOM.TOMBSTONE), em("state_key", "")], [...notify, highlight]),
			r(M.RULE.REACTION, [em("type", M.REACTION)], []),
			r(M.RULE.ROOM.SERVER_ACL, [em("type", M.ROOM.SERVER_ACL), em("state_key", "")], []),
			r(M.RULE.SUPPRESS_EDITS, [ep("content.m\\.relates_to.rel_type", M.REPLACE)], []),
			r(UNSTABLE.ORG.MATRIX.MSC3930.RULE.POLL_RESPONSE, [em("type", UNSTABLE.ORG.MATRIX.MSC3381.POLL.RESPONSE)], [])
		],
		content: [r(M.RULE.CONTAINS_USER_NAME, void 0, [
			...notify,
			sound("default"),
			highlight
		], { pattern: localpart })],
		postcontent: [r(UNSTABLE.IO.ELEMENT.MSC4306.RULE.UNSUBSCRIBED_THREAD, [{
			kind: UNSTABLE.IO.ELEMENT.MSC4306.THREAD_SUBSCRIPTION,
			subscribed: false
		}], []), r(UNSTABLE.IO.ELEMENT.MSC4306.RULE.SUBSCRIBED_THREAD, [{
			kind: UNSTABLE.IO.ELEMENT.MSC4306.THREAD_SUBSCRIPTION,
			subscribed: true
		}], [...notify, sound("default")])],
		room: [],
		sender: [],
		underride: [
			r(M.RULE.CALL, [em("type", M.CALL.INVITE)], [...notify, sound("ring")]),
			r(M.RULE.ENCRYPTED_ROOM_ONE_TO_ONE, [{
				kind: "room_member_count",
				is: "2"
			}, em("type", M.ROOM.ENCRYPTED)], [...notify, sound("default")]),
			r(M.RULE.ROOM_ONE_TO_ONE, [{
				kind: "room_member_count",
				is: "2"
			}, em("type", M.ROOM.MESSAGE)], [...notify, sound("default")]),
			r(M.RULE.MESSAGE, [em("type", M.ROOM.MESSAGE)], notify),
			r(UNSTABLE.ORG.MATRIX.MSC3930.RULE.POLL_START_ONE_TO_ONE, [{
				kind: "room_member_count",
				is: "2"
			}, em("type", UNSTABLE.ORG.MATRIX.MSC3381.POLL.START)], [...notify, sound("default")]),
			r(UNSTABLE.ORG.MATRIX.MSC3930.RULE.POLL_END_ONE_TO_ONE, [{
				kind: "room_member_count",
				is: "2"
			}, em("type", UNSTABLE.ORG.MATRIX.MSC3381.POLL.END)], [...notify, sound("default")]),
			r(UNSTABLE.ORG.MATRIX.MSC3930.RULE.POLL_START, [em("type", UNSTABLE.ORG.MATRIX.MSC3381.POLL.START)], notify),
			r(UNSTABLE.ORG.MATRIX.MSC3930.RULE.POLL_END, [em("type", UNSTABLE.ORG.MATRIX.MSC3381.POLL.END)], notify),
			r(M.RULE.ENCRYPTED, [em("type", M.ROOM.ENCRYPTED)], notify)
		]
	};
}
/** Look up a dotted path; `\.` escapes a literal dot in a key (e.g. `content.m\.relates_to`). */
function valueAtPath(obj, path) {
	const parts = [];
	let part = "";
	for (let i = 0; i < path.length; i++) {
		const c = path[i];
		if (c === "\\" && (path[i + 1] === "." || path[i + 1] === "\\")) part += path[++i];
		else if (c === ".") {
			parts.push(part);
			part = "";
		} else part += c;
	}
	parts.push(part);
	let cur = obj;
	for (const p of parts) {
		if (!isObject(cur) || !(p in cur)) return void 0;
		cur = cur[p];
	}
	return cur;
}
function conditionMatches(cond, ctx) {
	switch (cond.kind) {
		case "event_match": {
			if (typeof cond.key !== "string" || typeof cond.pattern !== "string") return false;
			const value = valueAtPath(ctx.event, cond.key);
			if (typeof value !== "string") return false;
			return cond.key === "content.body" ? globSearchWords(cond.pattern, value) : globMatch(cond.pattern, value, { caseInsensitive: true });
		}
		case "event_property_is": return typeof cond.key === "string" && valueAtPath(ctx.event, cond.key) === cond.value;
		case "event_property_contains": {
			const value = typeof cond.key === "string" ? valueAtPath(ctx.event, cond.key) : void 0;
			return Array.isArray(value) && value.includes(cond.value);
		}
		case "contains_display_name": {
			const body = ctx.event.content?.body;
			if (!ctx.displayName || typeof body !== "string") return false;
			const escaped = ctx.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`(^|\\W)${escaped}(\\W|$)`, "i").test(body);
		}
		case "room_member_count": {
			const m = /^(==|<=|>=|<|>)?(\d+)$/.exec(String(cond.is ?? ""));
			if (!m) return false;
			const n = Number(m[2]);
			switch (m[1] ?? "==") {
				case "==": return ctx.memberCount === n;
				case "<": return ctx.memberCount < n;
				case ">": return ctx.memberCount > n;
				case "<=": return ctx.memberCount <= n;
				case ">=": return ctx.memberCount >= n;
			}
			return false;
		}
		case UNSTABLE.IO.ELEMENT.MSC4306.THREAD_SUBSCRIPTION: return ctx.threadSubscribed !== void 0 && ctx.threadSubscribed !== null && ctx.threadSubscribed === cond.subscribed;
		case "sender_notification_permission": return typeof cond.key === "string" && ctx.senderLevel >= (ctx.notificationLevels[cond.key] ?? 50);
		default: return false;
	}
}
function ruleMatches(kind, rule, ctx) {
	if (!rule.enabled) return false;
	switch (kind) {
		case "override":
		case "postcontent":
		case "underride": return (rule.conditions ?? []).every((c) => conditionMatches(c, ctx));
		case "content": return typeof rule.pattern === "string" && conditionMatches({
			kind: "event_match",
			key: "content.body",
			pattern: rule.pattern
		}, ctx);
		case "room": return ctx.event.room_id === rule.rule_id;
		case "sender": return ctx.event.sender === rule.rule_id;
	}
	return false;
}
/** Evaluate a user's push rules against an event; returns the actions of the first matching rule, or null. */
function evaluatePushRules(rules, ctx) {
	for (const kind of PUSH_RULE_KINDS) for (const rule of rules[kind] ?? []) if (ruleMatches(kind, rule, ctx)) return rule.actions ?? [];
	return null;
}
/** The tweaks (`set_tweak`) of a rule's actions: `highlight` defaults to true when set without a value. */
function pushTweaks(actions) {
	const tweaks = {};
	for (const a of actions) if (isObject(a) && typeof a.set_tweak === "string") tweaks[a.set_tweak] = "value" in a ? a.value : true;
	return tweaks;
}
export { PUSH_RULE_KINDS, defaultPushRules, evaluatePushRules, pushTweaks, valueAtPath };

//# sourceMappingURL=push.js.map