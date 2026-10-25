import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPushRules, evaluatePushRules, pushTweaks, valueAtPath, type PushEvalContext } from "../src/push.ts";

const alice = "@alice:example.org";

function ctx(event: Record<string, unknown>, extra: Partial<PushEvalContext> = {}): PushEvalContext {
  return {
    event: { room_id: "!r:example.org", sender: "@bob:example.org", ...event },
    userId: alice,
    displayName: "Alice",
    memberCount: 3,
    senderLevel: 0,
    notificationLevels: { room: 50 },
    ...extra,
  };
}

const message = (body: string, extra: Record<string, unknown> = {}) => ({
  type: "m.room.message",
  content: { msgtype: "m.text", body, ...extra },
});

test("valueAtPath: dot-separated property paths with escapes (spec appendix)", () => {
  const obj = { content: { "m.relates_to": { rel_type: "m.replace" }, "a\\b": 1, x: { y: 2 } } };
  assert.equal(valueAtPath(obj, "content.m\\.relates_to.rel_type"), "m.replace");
  assert.equal(valueAtPath(obj, "content.a\\\\b"), 1);
  assert.equal(valueAtPath(obj, "content.x.y"), 2);
  assert.equal(valueAtPath(obj, "content.nope.y"), undefined);
});

test("the default rules: messages, mentions, room mentions, one-to-one rooms, notices, edits", () => {
  const rules = defaultPushRules(alice);
  const tweaks = (c: PushEvalContext) => {
    const actions = evaluatePushRules(rules, c);
    return actions?.includes("notify") ? pushTweaks(actions) : null;
  };
  assert.deepEqual(tweaks(ctx(message("hi all"))), {});
  assert.deepEqual(tweaks(ctx(message("hi Alice!"))), { sound: "default", highlight: true }, "display name");
  assert.deepEqual(tweaks(ctx(message("hey alice"))), { sound: "default", highlight: true }, "user name");
  assert.deepEqual(
    tweaks(ctx(message("ping", { "m.mentions": { user_ids: [alice] } }))),
    { sound: "default", highlight: true },
    "intentional mention",
  );
  assert.deepEqual(tweaks(ctx(message("x", { "m.mentions": { room: true } }))), {}, "@room needs the sender's power");
  assert.deepEqual(tweaks(ctx(message("x", { "m.mentions": { room: true } }), { senderLevel: 50 })), { highlight: true });
  assert.deepEqual(tweaks(ctx(message("hi"), { memberCount: 2 })), { sound: "default" }, "one-to-one");
  assert.deepEqual(tweaks(ctx({ type: "m.room.encrypted", content: {} }, { memberCount: 2 })), { sound: "default" });
  assert.equal(tweaks(ctx(message("x", { msgtype: "m.notice" }))), null, "notices are quiet");
  assert.equal(tweaks(ctx(message("* fixed", { "m.relates_to": { rel_type: "m.replace", event_id: "$e" } }))), null, "edits are quiet");
  assert.equal(tweaks(ctx({ type: "m.reaction", content: {} })), null);
  assert.deepEqual(
    tweaks(ctx({ type: "m.room.member", state_key: alice, content: { membership: "invite" } })),
    { sound: "default" },
    "an invite for me",
  );
});

test("user rules: room and sender rules, disabled rules, unknown conditions never match", () => {
  const rules = defaultPushRules(alice);
  rules.room = [{ rule_id: "!r:example.org", default: false, enabled: true, actions: [] }];
  assert.equal(evaluatePushRules(rules, ctx(message("hi")))?.includes("notify"), false, "a muted room");
  rules.room[0].enabled = false;
  assert.equal(evaluatePushRules(rules, ctx(message("hi")))?.includes("notify"), true);
  rules.override.unshift({ rule_id: "x", default: false, enabled: true, actions: [], conditions: [{ kind: "com.example.unknown" }] });
  assert.equal(evaluatePushRules(rules, ctx(message("hi")))?.includes("notify"), true, "the unknown rule is skipped");
});
