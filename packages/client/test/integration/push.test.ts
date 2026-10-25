import { test } from "node:test";
import assert from "node:assert/strict";
import type { MatrixEvent } from "../../src/models/event.ts";
import type { PushOutcome } from "../../src/push/push.ts";
import { homeserver, until } from "./helpers.ts";

test("push: pushers, rules, the notification list", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice", { e2ee: false });
    const bob = await t.login("bob", { e2ee: false });
    await alice.push.setPusher({
      pushkey: "token-1",
      kind: "http",
      app_id: "com.example.app",
      app_display_name: "Example",
      device_display_name: "Phone",
      lang: "en",
      data: { url: "https://push.example.com/_matrix/push/v1/notify" },
    });
    assert.deepEqual(
      (await alice.push.pushers()).map((p) => p.pushkey),
      ["token-1"],
    );
    await alice.push.removePusher("com.example.app", "token-1");
    assert.deepEqual(await alice.push.pushers(), []);

    const rules = await alice.push.rules();
    assert.ok(rules.override?.some((r) => r.rule_id === ".m.rule.master"));
    assert.deepEqual(await alice.push.rules({ scope: "global" }), rules);
    await alice.push.setRule("content", "pizza", { pattern: "pizza", actions: ["notify", { set_tweak: "highlight" }] });
    assert.equal((await alice.push.getRule("content", "pizza")).pattern, "pizza");
    await alice.push.setRuleEnabled("content", "pizza", false);
    assert.equal(await alice.push.isRuleEnabled("content", "pizza"), false);
    await alice.push.setRuleActions("content", "pizza", ["notify"]);
    assert.deepEqual(await alice.push.getRuleActions("content", "pizza"), ["notify"]);
    await alice.push.deleteRule("content", "pizza");
    assert.equal(
      (await alice.push.rules()).content?.some((r) => r.rule_id === "pizza"),
      false,
    );

    const roomId = await alice.createRoom({ invite: [bob.userId] });
    await bob.joinRoom(roomId);
    await bob.sendText(roomId, "hey alice, lunch?");
    const list = await until("the notification", async () => {
      const n = await alice.push.notifications();
      return n.notifications.length > 0 ? n : undefined;
    });
    assert.equal(list.notifications[0].room_id, roomId);
    const highlights = await alice.push.notifications({ only: "highlight" });
    assert.equal(highlights.notifications.length, 1);
  } finally {
    await t.close();
  }
});

test("push: encrypted messages are evaluated on their plaintext; muted rooms stay quiet; unread counts", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice");
    const bob = await t.login("bob");
    await Promise.all([alice.start(), bob.start()]);
    await Promise.all([alice.waitForPrepared(), bob.waitForPrepared()]);
    await alice.profile.setDisplayName("Alice");
    const roomId = await alice.createRoom({ encrypted: true, invite: [bob.userId] });
    await until("the invite", () => bob.getRoom(roomId)?.membership === "invite");
    await bob.joinRoom(roomId);
    await until("bob joined", () => alice.getRoom(roomId)?.state.membership(bob.userId) === "join");
    await until("bob sees the room", () => bob.getRoom(roomId)?.state.membership(alice.userId) === "join");

    const seen: Array<{ body: string; outcome: PushOutcome }> = [];
    alice.on("notification", (e: MatrixEvent, _room, outcome) => seen.push({ body: (e.content as { body: string }).body, outcome }));
    await bob.sendText(roomId, "just chatting");
    await bob.sendText(roomId, "Alice, look at this");
    await until("two notifications", () => seen.length >= 2);
    assert.equal(seen[0].body, "just chatting");
    assert.equal(seen[0].outcome.highlight, false);
    assert.equal(seen[1].body, "Alice, look at this");
    assert.equal(seen[1].outcome.highlight, true, "the display name, found in the plaintext");

    assert.deepEqual(alice.getUnreadCounts(roomId), { notification: 2, highlight: 1, exact: true });
    const last = alice.getRoom(roomId)!.lastEvent()!;
    await alice.sendReadReceipt(roomId, last.eventId!);
    await until("the receipt is synced", () => alice.getRoom(roomId)!.readReceipt(alice.userId)?.eventId === last.eventId);
    assert.deepEqual(alice.getUnreadCounts(roomId), { notification: 0, highlight: 0, exact: true });

    // Muted: mentions still notify (override rules come before room rules).
    await alice.push.muteRoom(roomId);
    await until("the rule is synced", () => alice.push.currentRules().room?.some((r) => r.rule_id === roomId));
    await bob.sendText(roomId, "quiet now");
    await bob.sendText(roomId, "Alice? anyone?");
    await until("the mention", () => seen.length >= 3);
    assert.deepEqual(
      seen.map((s) => s.body),
      ["just chatting", "Alice, look at this", "Alice? anyone?"],
    );

    // Muted fully: nothing notifies.
    await alice.push.muteRoom(roomId, { mentions: false });
    await until("the override is synced", () => alice.push.currentRules().override?.some((r) => r.rule_id === roomId));
    await bob.sendText(roomId, "Alice!!");
    const marker = await bob.sendText(roomId, "end");
    await until("bob's last message", () => alice.getRoom(roomId)!.timeline.find(marker)?.decryptionStatus === "decrypted");
    assert.equal(seen.length, 3, "a fully muted room does not notify");
    await alice.push.unmuteRoom(roomId);
    assert.equal(
      (await alice.push.rules()).override?.some((r) => r.rule_id === roomId),
      false,
    );
  } finally {
    await t.close();
  }
});
