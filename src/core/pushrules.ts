import { isObject } from "./json.ts";
import type { Homeserver } from "../homeserver.ts";

export type Rule = Record<string, any>;
export type Ruleset = Record<string, Rule[]>;

export const KINDS = ["override", "content", "postcontent", "room", "sender", "underride"];

export function defaultRules(userId: string): Ruleset {
  const localpart = userId.slice(1).split(":")[0];
  const notify = ["notify"];
  const sound = (s: string) => ({ set_tweak: "sound", value: s });
  const highlight = { set_tweak: "highlight" };
  const r = (rule_id: string, conditions: any[] | undefined, actions: any[], extra: Rule = {}) => ({
    rule_id, default: true, enabled: true, actions, ...(conditions ? { conditions } : {}), ...extra,
  });
  const em = (key: string, pattern: string) => ({ kind: "event_match", key, pattern });
  const ep = (key: string, value: unknown) => ({ kind: "event_property_is", key, value });
  return {
    override: [
      r(".m.rule.master", [], [], { enabled: false }),
      r(".m.rule.suppress_notices", [em("content.msgtype", "m.notice")], []),
      r(".m.rule.invite_for_me", [em("type", "m.room.member"), em("content.membership", "invite"), em("state_key", userId)], [...notify, sound("default")]),
      r(".m.rule.member_event", [em("type", "m.room.member")], []),
      r(".m.rule.is_user_mention", [{ kind: "event_property_contains", key: "content.m\\.mentions.user_ids", value: userId }], [...notify, sound("default"), highlight]),
      r(".m.rule.contains_display_name", [{ kind: "contains_display_name" }], [...notify, sound("default"), highlight]),
      r(".m.rule.is_room_mention", [ep("content.m\\.mentions.room", true), { kind: "sender_notification_permission", key: "room" }], [...notify, highlight]),
      r(".m.rule.roomnotif", [em("content.body", "@room"), { kind: "sender_notification_permission", key: "room" }], [...notify, highlight]),
      r(".m.rule.tombstone", [em("type", "m.room.tombstone"), em("state_key", "")], [...notify, highlight]),
      r(".m.rule.reaction", [em("type", "m.reaction")], []),
      r(".m.rule.room.server_acl", [em("type", "m.room.server_acl"), em("state_key", "")], []),
      r(".m.rule.suppress_edits", [ep("content.m\\.relates_to.rel_type", "m.replace")], []),
      r(".org.matrix.msc3930.rule.poll_response", [em("type", "org.matrix.msc3381.poll.response")], []),
    ],
    content: [
      r(".m.rule.contains_user_name", undefined, [...notify, sound("default"), highlight], { pattern: localpart }),
    ],
    // MSC4306: thread replies notify only in subscribed threads.
    postcontent: [
      r(".io.element.msc4306.rule.unsubscribed_thread", [{ kind: "io.element.msc4306.thread_subscription", subscribed: false }], []),
      r(".io.element.msc4306.rule.subscribed_thread", [{ kind: "io.element.msc4306.thread_subscription", subscribed: true }], [...notify, sound("default")]),
    ],
    room: [],
    sender: [],
    underride: [
      r(".m.rule.call", [em("type", "m.call.invite")], [...notify, sound("ring")]),
      r(".m.rule.encrypted_room_one_to_one", [{ kind: "room_member_count", is: "2" }, em("type", "m.room.encrypted")], [...notify, sound("default")]),
      r(".m.rule.room_one_to_one", [{ kind: "room_member_count", is: "2" }, em("type", "m.room.message")], [...notify, sound("default")]),
      r(".m.rule.message", [em("type", "m.room.message")], notify),
      r(".org.matrix.msc3930.rule.poll_start_one_to_one", [{ kind: "room_member_count", is: "2" }, em("type", "org.matrix.msc3381.poll.start")], [...notify, sound("default")]),
      r(".org.matrix.msc3930.rule.poll_end_one_to_one", [{ kind: "room_member_count", is: "2" }, em("type", "org.matrix.msc3381.poll.end")], [...notify, sound("default")]),
      r(".org.matrix.msc3930.rule.poll_start", [em("type", "org.matrix.msc3381.poll.start")], notify),
      r(".org.matrix.msc3930.rule.poll_end", [em("type", "org.matrix.msc3381.poll.end")], notify),
      r(".m.rule.encrypted", [em("type", "m.room.encrypted")], notify),
    ],
  };
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
  }
  return c;
}

export async function loadRules(hs: Homeserver, userId: string): Promise<Ruleset> {
  const cached = cacheFor(hs).get(userId);
  if (cached) return structuredClone(cached);
  const rules = await readRules(hs, userId);
  const cache = cacheFor(hs);
  if (cache.size > 5000) cache.clear();
  cache.set(userId, rules);
  return structuredClone(rules);
}

async function readRules(hs: Homeserver, userId: string): Promise<Ruleset> {
  const row = await hs.db.findOne("account_data", [{ field: "user_id", value: userId }, { field: "room_id", value: "" }, { field: "type", value: "m.push_rules" }]);
  if (!isObject(row?.content?.global)) return defaultRules(userId);
  const rules: Ruleset = row!.content.global;
  // Rulesets saved before a kind existed gain that kind's default rules.
  const defaults = defaultRules(userId);
  for (const kind of KINDS) if (!Array.isArray(rules[kind])) rules[kind] = defaults[kind];
  return rules;
}

export async function saveRules(hs: Homeserver, userId: string, rules: Ruleset): Promise<void> {
  cacheFor(hs).set(userId, structuredClone(rules));
  void hs.cluster.publish("pushrules", { from: hs.instanceId, userId }).catch(() => {});
  await hs.streams.write((stream) => hs.db.upsert("account_data", { user_id: userId, room_id: "", type: "m.push_rules", content: { global: rules }, stream }));
  hs.notifier.notify([userId]);
}

/** Copy room-specific push rules from an upgraded room's predecessor to the new room. */
export function copyRoomPushRules(hs: Homeserver, userId: string, oldRoomId: string, newRoomId: string): Promise<void> {
  return withRulesLock(hs, userId, () => copyRules(hs, userId, oldRoomId, newRoomId));
}

async function copyRules(hs: Homeserver, userId: string, oldRoomId: string, newRoomId: string): Promise<void> {
  const row = await hs.db.findOne("account_data", [{ field: "user_id", value: userId }, { field: "room_id", value: "" }, { field: "type", value: "m.push_rules" }]);
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
        copy.conditions = copy.conditions.map((c: any) => (c?.key === "room_id" && c?.pattern === oldRoomId ? { ...c, pattern: newRoomId } : c));
        if (!list.some((r) => r.rule_id === copy.rule_id)) additions.push(copy);
      }
    }
    if (additions.length) { rules[kind] = [...additions, ...list]; changed = true; }
  }
  if (changed) await saveRules(hs, userId, rules);
}
