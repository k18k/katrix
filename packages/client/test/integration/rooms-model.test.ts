import { test } from "node:test";
import assert from "node:assert/strict";
import { body, findEvent, homeserver, until } from "./helpers.ts";

async function pair(t: Awaited<ReturnType<typeof homeserver>>, opts: { encrypted?: boolean; preset?: "public_chat" } = {}) {
  const alice = await t.login("alice", opts.encrypted ? {} : { e2ee: false });
  const bob = await t.login("bob", opts.encrypted ? {} : { e2ee: false });
  await Promise.all([alice.start(), bob.start()]);
  await Promise.all([alice.waitForPrepared(), bob.waitForPrepared()]);
  const roomId = await alice.createRoom({ invite: [bob.userId], encrypted: opts.encrypted, preset: opts.preset });
  await until("the invite", () => bob.getRoom(roomId)?.membership === "invite");
  await bob.joinRoom(roomId);
  await until("bob joined", () => alice.getRoom(roomId)?.state.membership(bob.userId) === "join");
  await until("bob has the room", () => bob.getRoom(roomId)?.state.membership(alice.userId) === "join");
  return { alice, bob, roomId };
}

for (const encrypted of [false, true]) {
  test(`edits, reactions, replies and threads${encrypted ? " (encrypted)" : ""}`, async () => {
    const t = await homeserver();
    try {
      const { alice, bob, roomId } = await pair(t, { encrypted });
      const original = await alice.sendText(roomId, "I like cake");
      await alice.sendEdit(roomId, original, { msgtype: "m.text", body: "I like pie" });
      // Bob tries to edit Alice's message: not a valid replacement.
      await bob.sendEvent(roomId, "m.room.message", {
        msgtype: "m.text",
        body: "* hacked",
        "m.new_content": { msgtype: "m.text", body: "hacked" },
        "m.relates_to": { rel_type: "m.replace", event_id: original },
      });
      const marker = await bob.sendText(roomId, "marker");
      await until("the edit", () => {
        const e = bob.getRoom(roomId)?.timeline.find(original);
        return (
          e?.isEdited() &&
          bob.getRoom(roomId)?.timeline.find(marker) &&
          alice.getRoom(roomId)?.timeline.find(marker)?.decryptionStatus !== "pending"
        );
      });
      const seen = bob.getRoom(roomId)!.timeline.find(original)!;
      assert.equal((seen.latestContent as { body: string }).body, "I like pie", "the newest valid edit, not Bob's");
      assert.equal(body(seen), "I like cake", "content stays the original");

      await bob.sendReaction(roomId, original, "👍");
      await alice.sendReaction(roomId, original, "👍");
      await alice.sendReaction(roomId, original, "❤️");
      await until(
        "three reactions",
        () =>
          alice
            .getRoom(roomId)!
            .reactions(original)
            .reduce((n, g) => n + g.count, 0) === 3,
      );
      const groups = alice.getRoom(roomId)!.reactions(original);
      assert.deepEqual(
        groups.map((g) => [g.key, g.count]),
        [
          ["👍", 2],
          ["❤️", 1],
        ],
      );
      assert.ok(groups[0].myEventId);
      assert.equal(await alice.removeReaction(roomId, original, "❤️"), true);
      await until("the reaction is gone", () => alice.getRoom(roomId)!.reactions(original).length === 1);

      const r1 = await bob.sendThreadMessage(roomId, original, { msgtype: "m.text", body: "thread reply 1" });
      await until("bob sees his reply", () => bob.getRoom(roomId)!.timeline.find(r1));
      await bob.sendThreadMessage(roomId, original, { msgtype: "m.text", body: "thread reply 2" });
      const summary = await until("the thread", () => {
        const s = alice.getRoom(roomId)!.threadSummary(original);
        return s && s.count === 2 && s.latestEvent && body(s.latestEvent) === "thread reply 2" ? s : undefined;
      });
      assert.equal(summary.participated, true, "alice wrote the root");
      assert.deepEqual(alice.getRoom(roomId)!.threadRoots(), [original]);
      assert.ok(
        !alice
          .getRoom(roomId)!
          .mainTimeline()
          .some((e) => e.threadRootId),
      );

      // A reply to a thread reply stays in the thread and mentions its sender.
      const reply = await alice.sendReply(roomId, r1, { msgtype: "m.text", body: "replying in the thread" });
      const got = await until("the reply", () => findEvent(bob, roomId, (e) => e.eventId === reply && e.decryptionStatus !== "pending"));
      assert.equal(got.threadRootId, original);
      assert.equal(got.replyToEventId, r1);
      assert.deepEqual((got.content as { "m.mentions"?: { user_ids?: string[] } })["m.mentions"]?.user_ids, [bob.userId]);
    } finally {
      await t.close();
    }
  });
}

test("direct chats: m.direct on both sides, findDirectRoom", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice", { e2ee: false });
    const bob = await t.login("bob", { e2ee: false });
    await Promise.all([alice.start(), bob.start()]);
    await Promise.all([alice.waitForPrepared(), bob.waitForPrepared()]);
    const roomId = await alice.createDirectRoom(bob.userId, { encrypted: false });
    assert.deepEqual(alice.getDirectRooms(), { [bob.userId]: [roomId] });
    await until("the invite", () => bob.getRoom(roomId)?.membership === "invite");
    await bob.joinRoom(roomId);
    assert.deepEqual(bob.getDirectRooms(), { [alice.userId]: [roomId] }, "is_direct was honoured");
    await until(
      "both joined",
      () => alice.findDirectRoom(bob.userId)?.roomId === roomId && bob.findDirectRoom(alice.userId)?.roomId === roomId,
    );
    await alice.markDirect(roomId, bob.userId, false);
    assert.deepEqual(alice.getDirectRooms(), {});
  } finally {
    await t.close();
  }
});

test("spaces: children in order, parents, hierarchy", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice", { e2ee: false });
    await alice.start();
    await alice.waitForPrepared();
    const space = await alice.spaces.create({ name: "Company" });
    const general = await alice.createRoom({ name: "general" });
    const random = await alice.createRoom({ name: "random" });
    await alice.spaces.addChild(space, random);
    await alice.spaces.addChild(space, general, { order: "a", suggested: true });
    await alice.spaces.setParent(general, space, { canonical: true });
    await until("the space state", () => alice.spaces.children(space).length === 2 && alice.spaces.parents(general).length === 1);
    assert.equal(alice.getRoom(space)!.isSpace(), true);
    assert.deepEqual(
      alice.spaces.children(space).map((c) => [c.roomId, c.suggested]),
      [
        [general, true],
        [random, false],
      ],
      "ordered children first",
    );
    assert.deepEqual(alice.spaces.parents(general), [{ spaceId: space, via: ["localhost"], canonical: true }]);
    const tree = await alice.spaces.fullHierarchy(space);
    assert.deepEqual(new Set(tree.map((r) => r.room_id)), new Set([space, general, random]));
    await alice.spaces.removeChild(space, random);
    await until("removed", () => alice.spaces.children(space).length === 1);
  } finally {
    await t.close();
  }
});

test("room upgrades: successor, predecessor, followUpgrade", async () => {
  const t = await homeserver();
  try {
    // Public: the upgraded room keeps the join rule, and an invite-only one would need new invites.
    const { alice, bob, roomId } = await pair(t, { preset: "public_chat" });
    const newRoom = await alice.upgradeRoom(roomId, "11");
    await until("the tombstone", () => bob.getRoom(roomId)?.successor()?.roomId === newRoom);
    assert.equal(await bob.followUpgrade(roomId), newRoom);
    await until("bob in the new room", () => bob.getRoom(newRoom)?.membership === "join");
    assert.equal(bob.getRoom(newRoom)!.predecessor()?.roomId, roomId);
  } finally {
    await t.close();
  }
});
