import { PUSH_RULE_KINDS, defaultPushRules } from "../packages/shared/src/push.js";
import { isObject } from "../packages/shared/src/json.js";
import { M } from "../packages/shared/src/m.js";
import { CLUSTER_RESYNC } from "./cluster.js";
// src/core/pushrules.ts
const KINDS = PUSH_RULE_KINDS;
function defaultRules(userId) {
	return defaultPushRules(userId);
}
/** Serialise read-modify-write cycles on a user's push rules (cluster-wide). */
function withRulesLock(hs, userId, fn) {
	return hs.cluster.lock(`pushrules:${userId}`, () => {
		cacheFor(hs).delete(userId);
		return fn();
	});
}
const rulesCache = /* @__PURE__ */ new WeakMap();
function cacheFor(hs) {
	let c = rulesCache.get(hs);
	if (!c) {
		const cache = /* @__PURE__ */ new Map();
		rulesCache.set(hs, c = cache);
		hs.cluster.subscribe("pushrules", (msg) => {
			if (msg?.from !== hs.instanceId) cache.delete(msg.userId);
		});
		hs.cluster.subscribe(CLUSTER_RESYNC, () => cache.clear());
	}
	return c;
}
/** A user's push rules, as a copy the caller may change. */
async function loadRules(hs, userId) {
	return structuredClone(await readOnlyRules(hs, userId));
}
/**
* A user's push rules, shared and frozen: for callers that only read them.
*
* https://github.com/k18k/katrix/issues/41: push evaluation copied every
* member's rules for every message, about 6% of the CPU under load, though it only reads them.
* The cached rulesets are deep-frozen, so a caller that tries to change one fails loudly instead
* of changing everyone's.
*/
async function readOnlyRules(hs, userId) {
	const cached = cacheFor(hs).get(userId);
	if (cached) return cached;
	const rules = deepFreeze(await readRules(hs, userId));
	const cache = cacheFor(hs);
	if (cache.size > 5e3) cache.clear();
	cache.set(userId, rules);
	return rules;
}
function deepFreeze(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value)) deepFreeze(v);
	}
	return value;
}
async function readRules(hs, userId) {
	const row = await hs.db.findOne("account_data", [
		{
			field: "user_id",
			value: userId
		},
		{
			field: "room_id",
			value: ""
		},
		{
			field: "type",
			value: M.PUSH_RULES
		}
	]);
	if (!isObject(row?.content?.global)) return defaultRules(userId);
	const rules = row.content.global;
	const defaults = defaultRules(userId);
	for (const kind of KINDS) if (!Array.isArray(rules[kind])) rules[kind] = defaults[kind];
	return rules;
}
async function saveRules(hs, userId, rules) {
	cacheFor(hs).set(userId, deepFreeze(structuredClone(rules)));
	hs.cluster.publish("pushrules", {
		from: hs.instanceId,
		userId
	}).catch((err) => hs.logger.warn("Push rules cache invalidation failed; other instances may use stale rules", err));
	await hs.streams.write((stream) => hs.db.upsert("account_data", {
		user_id: userId,
		room_id: "",
		type: M.PUSH_RULES,
		content: { global: rules },
		stream
	}));
	hs.notifier.notify([userId]);
}
/** Copy room-specific push rules from an upgraded room's predecessor to the new room. */
function copyRoomPushRules(hs, userId, oldRoomId, newRoomId) {
	return withRulesLock(hs, userId, () => copyRules(hs, userId, oldRoomId, newRoomId));
}
async function copyRules(hs, userId, oldRoomId, newRoomId) {
	const row = await hs.db.findOne("account_data", [
		{
			field: "user_id",
			value: userId
		},
		{
			field: "room_id",
			value: ""
		},
		{
			field: "type",
			value: M.PUSH_RULES
		}
	]);
	if (!isObject(row?.content?.global)) return;
	const rules = row.content.global;
	let changed = false;
	for (const kind of KINDS) {
		const list = rules[kind] ?? [];
		const additions = [];
		for (const rule of list) {
			if (rule.default) continue;
			if (kind === "room" && rule.rule_id === oldRoomId) {
				if (!list.some((r) => r.rule_id === newRoomId)) additions.push({
					...structuredClone(rule),
					rule_id: newRoomId
				});
			} else if (Array.isArray(rule.conditions) && rule.conditions.some((c) => isObject(c) && c.key === "room_id" && c.pattern === oldRoomId)) {
				const copy = structuredClone(rule);
				copy.rule_id = `${rule.rule_id}-${newRoomId}`;
				copy.conditions = rule.conditions.map((c) => isObject(c) && c.key === "room_id" && c.pattern === oldRoomId ? {
					...c,
					pattern: newRoomId
				} : c);
				if (!list.some((r) => r.rule_id === copy.rule_id)) additions.push(copy);
			}
		}
		if (additions.length) {
			rules[kind] = [...additions, ...list];
			changed = true;
		}
	}
	if (changed) await saveRules(hs, userId, rules);
}
export { KINDS, copyRoomPushRules, defaultRules, loadRules, readOnlyRules, saveRules, withRulesLock };

//# sourceMappingURL=pushrules.js.map