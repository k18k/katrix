import { defaultPushRules, isObject, M, PUSH_RULE_KINDS } from "@katrix/shared";
import { CLUSTER_RESYNC } from "#core/cluster.ts";
import type { Homeserver } from "#homeserver.ts";

export type Rule = Record<string, any>;
export type Ruleset = Record<string, Rule[]>;

export const KINDS: readonly string[] = PUSH_RULE_KINDS;

export function defaultRules(userId: string): Ruleset {
  return defaultPushRules(userId);
}

/** Serialise read-modify-write cycles on a user's push rules (cluster-wide). */
export function withRulesLock<T>(hs: Homeserver, userId: string, fn: () => Promise<T>): Promise<T> {
  return hs.cluster.lock(`pushrules:${userId}`, () => {
    cacheFor(hs).delete(userId);
    return fn();
  });
}

const rulesCache = new WeakMap<Homeserver, Map<string, Ruleset>>();

function cacheFor(hs: Homeserver): Map<string, Ruleset> {
  let c = rulesCache.get(hs);
  if (!c) {
    const cache = new Map<string, Ruleset>();
    rulesCache.set(hs, (c = cache));
    hs.cluster.subscribe("pushrules", (msg: { from: string; userId: string }) => {
      if (msg?.from !== hs.instanceId) cache.delete(msg.userId);
    });
    hs.cluster.subscribe(CLUSTER_RESYNC, () => cache.clear());
  }
  return c;
}

/** A user's push rules, as a copy the caller may change. */
export async function loadRules(hs: Homeserver, userId: string): Promise<Ruleset> {
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
export async function readOnlyRules(hs: Homeserver, userId: string): Promise<Readonly<Ruleset>> {
  const cached = cacheFor(hs).get(userId);
  if (cached) return cached;
  const rules = deepFreeze(await readRules(hs, userId));
  const cache = cacheFor(hs);
  if (cache.size > 5000) cache.clear();
  cache.set(userId, rules);
  return rules;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

async function readRules(hs: Homeserver, userId: string): Promise<Ruleset> {
  const row = await hs.db.findOne("account_data", [
    { field: "user_id", value: userId },
    { field: "room_id", value: "" },
    { field: "type", value: M.PUSH_RULES },
  ]);
  if (!isObject(row?.content?.global)) return defaultRules(userId);
  const rules: Ruleset = row!.content.global;
  // Rulesets saved before a kind existed gain that kind's default rules.
  const defaults = defaultRules(userId);
  for (const kind of KINDS) if (!Array.isArray(rules[kind])) rules[kind] = defaults[kind];
  return rules;
}

export async function saveRules(hs: Homeserver, userId: string, rules: Ruleset): Promise<void> {
  cacheFor(hs).set(userId, deepFreeze(structuredClone(rules)));
  void hs.cluster.publish("pushrules", { from: hs.instanceId, userId }).catch(() => {});
  await hs.streams.write((stream) =>
    hs.db.upsert("account_data", { user_id: userId, room_id: "", type: M.PUSH_RULES, content: { global: rules }, stream }),
  );
  hs.notifier.notify([userId]);
}

/** Copy room-specific push rules from an upgraded room's predecessor to the new room. */
export function copyRoomPushRules(hs: Homeserver, userId: string, oldRoomId: string, newRoomId: string): Promise<void> {
  return withRulesLock(hs, userId, () => copyRules(hs, userId, oldRoomId, newRoomId));
}

async function copyRules(hs: Homeserver, userId: string, oldRoomId: string, newRoomId: string): Promise<void> {
  const row = await hs.db.findOne("account_data", [
    { field: "user_id", value: userId },
    { field: "room_id", value: "" },
    { field: "type", value: M.PUSH_RULES },
  ]);
  if (!isObject(row?.content?.global)) return;
  const rules: Ruleset = row!.content.global;
  let changed = false;
  for (const kind of KINDS) {
    const list = rules[kind] ?? [];
    const additions: Rule[] = [];
    for (const rule of list) {
      if (rule.default) continue;
      if (kind === "room" && rule.rule_id === oldRoomId) {
        if (!list.some((r) => r.rule_id === newRoomId)) additions.push({ ...structuredClone(rule), rule_id: newRoomId });
      } else if (Array.isArray(rule.conditions) && rule.conditions.some((c: any) => c?.key === "room_id" && c?.pattern === oldRoomId)) {
        const copy = structuredClone(rule);
        copy.rule_id = `${rule.rule_id}-${newRoomId}`;
        copy.conditions = copy.conditions.map((c: any) =>
          c?.key === "room_id" && c?.pattern === oldRoomId ? { ...c, pattern: newRoomId } : c,
        );
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
