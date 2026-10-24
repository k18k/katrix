import { test } from "node:test";
import assert from "node:assert/strict";
import { MatrixClient } from "../../src/client.ts";
import { MatrixError } from "../../src/http/errors.ts";
import { MemoryStorage } from "../../src/storage/memory.ts";
import { Auth } from "../../src/auth/login.ts";
import { body, findEvent, homeserver, until } from "./helpers.ts";

test("login flows, password login, whoami, profile", async () => {
  const t = await homeserver();
  try {
    const flows = await new Auth({ baseUrl: t.baseUrl, http: t.http }).loginFlows();
    assert.ok(flows.some((f) => f.type === "m.login.password"));
    const alice = await t.login("alice");
    assert.equal((await alice.whoami()).user_id, "@alice:localhost");
    await alice.setDisplayName("Alice A.");
    assert.equal((await alice.getProfile(alice.userId)).displayname, "Alice A.");
    const wrong = await new Auth({ baseUrl: t.baseUrl, http: t.http }).loginWithPassword("alice", "nope").catch((e) => e);
    assert.ok(wrong instanceof MatrixError && wrong.errcode === "M_FORBIDDEN");
    const registered = await new Auth({ baseUrl: t.baseUrl, http: t.http }).register("newbie", "a long password");
    assert.equal(registered.userId, "@newbie:localhost");
  } finally {
    await t.close();
  }
});

test("rooms, state, membership and messages arrive through /sync; local echoes are replaced", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice", { e2ee: false });
    const bob = await t.login("bob", { e2ee: false });
    await Promise.all([alice.start(), bob.start()]);
    await Promise.all([alice.waitForPrepared(), bob.waitForPrepared()]);

    const memberships: string[] = [];
    bob.on("room.membership", (_room, m) => memberships.push(m));
    const roomId = await alice.createRoom({ name: "Plaza", topic: "chat", invite: [bob.userId] });
    await until("the invite", () => bob.getRoom(roomId)?.membership === "invite");
    assert.equal(bob.getRoom(roomId)!.name(), "Plaza", "named from the invite's stripped state");
    await bob.joinRoom(roomId);
    await until("bob joined", () => alice.getRoom(roomId)?.state.membership(bob.userId) === "join");
    assert.deepEqual(memberships, ["invite", "join"]);

    const room = alice.getRoom(roomId)!;
    assert.equal(room.name(), "Plaza");
    assert.equal(room.state.get("m.room.topic")?.content.topic, "chat");
    assert.deepEqual(
      room.state
        .members()
        .filter((m) => m.membership === "join")
        .map((m) => m.userId)
        .sort(),
      [alice.userId, bob.userId],
    );
    assert.equal(room.state.powerLevel(alice.userId), 100);

    const echoes: string[] = [];
    alice.on("room.localEcho", (e) => echoes.push(e.localStatus!));
    const eventId = await alice.sendText(roomId, "hello");
    assert.deepEqual(echoes, ["sending", "sent"]);
    const got = await until("bob gets it", () => findEvent(bob, roomId, (e) => body(e) === "hello"));
    assert.equal(got.eventId, eventId);
    // Alice's own copy from /sync replaced the echo: one event, with the server's ID.
    await until("alice's sync", async () => {
      await new Promise((r) => setTimeout(r, 50));
      return true;
    });
    const mine = room.timeline.events.filter((e) => body(e) === "hello");
    assert.equal(mine.length, 1);
    assert.equal(mine[0].eventId, eventId);
    assert.equal(mine[0].localStatus, "sent");

    await alice.setRoomName(roomId, "Plaza 2");
    await until("the new name", () => bob.getRoom(roomId)?.name() === "Plaza 2");

    // Reactions, redactions, receipts, typing.
    await bob.sendReaction(roomId, eventId, "👍");
    await until("the reaction", () => findEvent(alice, roomId, (e) => e.type === "m.reaction"));
    await alice.redactEvent(roomId, eventId, "oops");
    await until("the redaction", () => findEvent(bob, roomId, (e) => e.eventId === eventId)?.isRedacted());
    assert.equal(body(findEvent(bob, roomId, (e) => e.eventId === eventId)!), undefined);
    await bob.sendReadReceipt(roomId, got.eventId!);
    await until("the receipt", () => alice.getRoom(roomId)?.readReceipt(bob.userId)?.eventId === got.eventId);
    await bob.setTyping(roomId, true);
    await until("typing", () => alice.getRoom(roomId)?.typing.includes(bob.userId));

    await alice.kick(roomId, bob.userId, "bye");
    await until("bob kicked", () => bob.getRoom(roomId)?.membership === "leave");
  } finally {
    await t.close();
  }
});

test("back-pagination fills the timeline to the room's start", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice", { e2ee: false });
    await alice.start();
    await alice.waitForPrepared();
    const roomId = await alice.createRoom({ name: "History" });
    await until("room", () => alice.getRoom(roomId));
    for (let i = 0; i < 25; i++) await alice.sendText(roomId, `m${i}`);
    await alice.stop();

    const late = await t.login("alice", { create: false, e2ee: false, sync: { timelineLimit: 5, pollTimeoutMs: 1000 } });
    await late.start();
    await late.waitForPrepared();
    const room = late.getRoom(roomId)!;
    assert.ok(room.timeline.events.length <= 5);
    while ((await late.paginateBackwards(roomId, 10)) > 0);
    assert.ok(room.timeline.atStart);
    const bodies = room.timeline.events.map(body).filter((b): b is string => b !== undefined && b.startsWith("m"));
    assert.deepEqual(
      bodies,
      Array.from({ length: 25 }, (_, i) => `m${i}`),
    );
    assert.equal(room.timeline.events[0].type, "m.room.create");
  } finally {
    await t.close();
  }
});

test("a client resumes from its storage: same rooms, next sync token, no duplicate events", async () => {
  const t = await homeserver();
  try {
    const storage = new MemoryStorage();
    const first = await t.login("alice", { e2ee: false, storage });
    await first.start();
    await first.waitForPrepared();
    const roomId = await first.createRoom({ name: "Kept" });
    await until("room", () => first.getRoom(roomId));
    await first.sendText(roomId, "before restart");
    await until("echo synced", () => findEvent(first, roomId, (e) => body(e) === "before restart" && e.localStatus === "sent"));
    await until("token stored", async () => (await first.store.get("sync", "token")) !== undefined);
    await first.stop();
    const credentials = {
      userId: first.userId,
      deviceId: first.deviceId,
      accessToken: (first as unknown as { tokens: { accessToken(): string } }).tokens.accessToken(),
    };

    const second = new MatrixClient({ baseUrl: t.baseUrl, http: t.http, credentials, storage, e2ee: false, sync: { pollTimeoutMs: 1000 } });
    let fullSync = false;
    second.on("room", () => (fullSync = true));
    await second.start();
    assert.equal(second.getRoom(roomId)?.name(), "Kept", "loaded from storage before any sync");
    await second.waitForPrepared();
    assert.equal(fullSync, false, "no room was new: the sync continued from the stored token");
    await first.sendText(roomId, "after restart").catch(() => {});
    await second.sendText(roomId, "after restart 2");
    await until("new message", () => findEvent(second, roomId, (e) => body(e) === "after restart 2" && e.localStatus === "sent"));
    assert.equal(second.getRoom(roomId)!.timeline.events.filter((e) => body(e) === "before restart").length, 1);
    await second.stop();
  } finally {
    await t.close();
  }
});

test("security: no plaintext into an encrypted room, with E2EE off or before the room is synced", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice", { e2ee: false });
    await alice.start();
    await alice.waitForPrepared();
    const roomId = await alice.createRoom({ encrypted: true });
    await until("room", () => alice.getRoom(roomId)?.isEncrypted());
    await assert.rejects(alice.sendText(roomId, "leak?"), /encryption is turned off/);
    const failed = alice.getRoom(roomId)!.timeline.events.find((e) => body(e) === "leak?");
    assert.equal(failed?.localStatus, "failed");

    // A client that has not synced the room asks the server before sending.
    const bob = await t.login("bob", { e2ee: false });
    await alice.invite(roomId, bob.userId);
    await bob.joinRoom(roomId);
    await assert.rejects(bob.sendText(roomId, "unknown room"), /encrypted and not synced/);
    const plainRoom = await alice.createRoom({ preset: "public_chat" });
    await bob.joinRoom(plainRoom);
    assert.match(await bob.sendText(plainRoom, "fine in the clear"), /^\$/);
  } finally {
    await t.close();
  }
});

test("a revoked access token stops the sync loop with loggedOut", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice", { e2ee: false });
    await alice.start();
    await alice.waitForPrepared();
    const loggedOut = alice.waitFor("loggedOut");
    await alice.api.request("POST", "/v3/logout", { body: {} });
    const [err] = await loggedOut;
    assert.equal(err.errcode, "M_UNKNOWN_TOKEN");
  } finally {
    await t.close();
  }
});
