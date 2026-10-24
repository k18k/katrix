import { test } from "node:test";
import assert from "node:assert/strict";
import { MatrixClient } from "../../src/client.ts";
import { MemoryStorage } from "../../src/storage/memory.ts";
import { body, findEvent, homeserver, until } from "./helpers.ts";

test("two clients exchange end-to-end encrypted messages through packages/core", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice");
    const bob = await t.login("bob");
    await alice.start();
    await bob.start();
    await alice.waitForPrepared();
    await bob.waitForPrepared();

    const roomId = await alice.createRoom({ name: "Secret", encrypted: true, invite: [bob.userId], preset: "private_chat" });
    await until("bob's invite", () => bob.getRoom(roomId)?.membership === "invite");
    await bob.joinRoom(roomId);
    await until("alice sees bob join", () => alice.getRoom(roomId)?.state.membership(bob.userId) === "join");

    await alice.sendText(roomId, "hello bob");
    const received = await until("bob decrypts", () =>
      findEvent(bob, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "hello bob"),
    );
    assert.equal(received.isEncrypted(), true);
    assert.equal(received.type, "m.room.message");
    assert.equal(received.sender, alice.userId);
    assert.equal(received.decryptionInfo?.authenticity, "authenticated");
    assert.equal(received.decryptionInfo?.senderDeviceId, alice.deviceId);

    await bob.sendText(roomId, "hi alice");
    await until("alice decrypts", () => findEvent(alice, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "hi alice"));

    // What the server stored is ciphertext.
    const raw = findEvent(alice, roomId, (e) => body(e) === "hi alice")!;
    assert.equal(raw.wire.type, "m.room.encrypted");
    assert.ok(!JSON.stringify(raw.wire).includes("hi alice"));
  } finally {
    await t.close();
  }
});

async function encryptedRoom(t: Awaited<ReturnType<typeof homeserver>>, names: string[], opts: { rotationPeriodMsgs?: number } = {}) {
  const clients = [];
  for (const n of names) clients.push(await t.login(n));
  for (const c of clients) await c.start();
  for (const c of clients) await c.waitForPrepared();
  const [owner, ...others] = clients;
  const roomId = await owner.createRoom({
    preset: "private_chat",
    invite: others.map((c) => c.userId),
    initialState: [
      {
        type: "m.room.encryption",
        content: {
          algorithm: "m.megolm.v1.aes-sha2",
          ...(opts.rotationPeriodMsgs ? { rotation_period_msgs: opts.rotationPeriodMsgs } : {}),
        },
      },
    ],
  });
  for (const c of others) {
    await until("invite", () => c.getRoom(roomId)?.membership === "invite");
    await c.joinRoom(roomId);
  }
  for (const c of others) await until("joined", () => owner.getRoom(roomId)?.state.membership(c.userId) === "join");
  return { clients, roomId };
}

const sessionOf = (e: { wire: { content: unknown } }) => (e.wire.content as { session_id: string }).session_id;

test("the Megolm session rotates when a member leaves; the leaver cannot read what follows", async () => {
  const t = await homeserver();
  try {
    const {
      clients: [alice, bob, carol],
      roomId,
    } = await encryptedRoom(t, ["alice", "bob", "carol"]);
    await alice.sendText(roomId, "for everyone");
    const first = await until("carol decrypts", () =>
      findEvent(carol, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "for everyone"),
    );
    await carol.leaveRoom(roomId);
    await until("alice sees carol leave", () => alice.getRoom(roomId)?.state.membership(carol.userId) === "leave");
    await alice.sendText(roomId, "after carol left");
    const second = await until("bob decrypts", () =>
      findEvent(bob, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "after carol left"),
    );
    assert.notEqual(sessionOf(second), sessionOf(first), "a new session");
    // Carol has no key for the new session (and, having left, no longer gets the room's events).
    const carolKey = await carol.store.get("inbound_group_sessions", `${roomId}|${sessionOf(second)}`);
    assert.equal(carolKey, undefined);
  } finally {
    await t.close();
  }
});

test("rotation after rotation_period_msgs messages; a new device gets the key without a rotation", async () => {
  const t = await homeserver();
  try {
    const {
      clients: [alice, bob],
      roomId,
    } = await encryptedRoom(t, ["alice", "bob"], { rotationPeriodMsgs: 3 });
    for (let i = 0; i < 4; i++) await alice.sendText(roomId, `n${i}`);
    const got = await until("bob decrypts all", () => {
      const events = bob.getRoom(roomId)?.timeline.events.filter((e) => e.decryptionStatus === "decrypted" && body(e)?.startsWith("n"));
      return events && events.length === 4 ? events : undefined;
    });
    assert.equal(new Set(got.slice(0, 3).map(sessionOf)).size, 1);
    assert.notEqual(sessionOf(got[3]), sessionOf(got[0]), "the fourth message starts a new session");

    // Bob logs in on a second device: Alice shares the current session with it at its current
    // index; it reads new messages but not the ones before it existed.
    const bob2 = await t.login("bob", { create: false });
    await bob2.start();
    await bob2.waitForPrepared();
    // Alice learns of the new device from device_lists.changed in her /sync.
    await until(
      "alice hears of bob's new device",
      async () => (await alice.e2ee!.devices.isOutdated(bob.userId)) || (await alice.e2ee!.devices.devices(bob.userId)).length === 2,
    );
    await alice.sendText(roomId, "hello second device");
    const fresh = await until("bob2 decrypts", () =>
      findEvent(bob2, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "hello second device"),
    );
    assert.equal(sessionOf(fresh), sessionOf(got[3]), "no rotation for a new device");
    const old = bob2.getRoom(roomId)!.timeline.events.find((e) => sessionOf(e as never) === sessionOf(got[0]));
    if (old) assert.equal(old.decryptionStatus, "failed");
  } finally {
    await t.close();
  }
});

test("keys survive a restart: the same storage decrypts history and new messages", async () => {
  const t = await homeserver();
  try {
    const storage = new MemoryStorage();
    const pickleKey = new Uint8Array(32).fill(7);
    const alice = await t.login("alice");
    const bob = await t.login("bob", { storage, e2ee: { pickleKey } });
    await alice.start();
    await bob.start();
    await alice.waitForPrepared();
    await bob.waitForPrepared();
    const roomId = await alice.createRoom({ encrypted: true, invite: [bob.userId] });
    await until("invite", () => bob.getRoom(roomId)?.membership === "invite");
    await bob.joinRoom(roomId);
    await until("join", () => alice.getRoom(roomId)?.state.membership(bob.userId) === "join");
    await alice.sendText(roomId, "before restart");
    await until("bob decrypts", () => findEvent(bob, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "before restart"));
    await bob.stop();

    // Nothing secret is stored in the clear: pickles are encrypted, the timeline is ciphertext.
    for (const [, value] of await storage.list("room_timeline", "")) assert.ok(!value.includes("before restart"));
    for (const store of ["account", "olm_sessions", "inbound_group_sessions"] as const) {
      for (const [, value] of await storage.list(store, "")) assert.match(JSON.parse(value).pickle, /^e1:/);
    }

    const credentials = {
      userId: bob.userId,
      deviceId: bob.deviceId,
      accessToken: (bob as unknown as { tokens: { accessToken(): string } }).tokens.accessToken(),
    };
    const again = new MatrixClient({
      baseUrl: t.baseUrl,
      http: t.http,
      credentials,
      storage,
      e2ee: { pickleKey },
      sync: { pollTimeoutMs: 1000 },
    });
    await again.start();
    // History from storage is decrypted again on start.
    const restored = findEvent(again, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "before restart");
    assert.ok(restored, "stored history decrypts after the restart");
    await again.waitForPrepared();
    await alice.sendText(roomId, "after restart");
    await until("decrypts after restart", () =>
      findEvent(again, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "after restart"),
    );
    await again.sendText(roomId, "reply after restart");
    await until("alice decrypts the reply", () =>
      findEvent(alice, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "reply after restart"),
    );
    await again.stop();

    // The wrong pickle key: the client does not start rather than create a new identity.
    const wrong = new MatrixClient({ baseUrl: t.baseUrl, http: t.http, credentials, storage, e2ee: { pickleKey: new Uint8Array(32) } });
    await assert.rejects(wrong.start(), /pickle key/i);
  } finally {
    await t.close();
  }
});

test("one-time keys are topped up after others claim them, and a used fallback key is replaced", async () => {
  const t = await homeserver();
  try {
    const bob = await t.login("bob");
    await bob.start();
    await bob.waitForPrepared();
    const counts = async () =>
      (await bob.api.request<{ one_time_key_counts: Record<string, number> }>("POST", "/v3/keys/upload", { body: {} })).one_time_key_counts;
    assert.equal((await counts()).signed_curve25519, 50);
    const claimer = await t.login("claimer", { e2ee: false });
    // Bob is offline while his keys are claimed, so the counts below are exact.
    await bob.stop();
    for (let i = 0; i < 30; i++) {
      await claimer.api.request("POST", "/v3/keys/claim", {
        body: { one_time_keys: { [bob.userId]: { [bob.deviceId]: "signed_curve25519" } } },
      });
    }
    assert.equal((await counts()).signed_curve25519, 20);
    // The next sync reports the count; the client uploads 30 new keys.
    await bob.start();
    await bob.sendText(await bob.createRoom({}), "nudge").catch(() => {});
    await until("topped up", async () => (await counts()).signed_curve25519 === 50);

    // Claim them all and one more: the server hands out the fallback key and reports it used.
    const fallbackKey = async () =>
      JSON.parse((await bob.store.get<{ pickle: string }>("account", "account"))!.pickle).fallback.public_key as string;
    const before = await fallbackKey();
    await bob.stop();
    let claimed: any;
    for (let i = 0; i < 51; i++) {
      claimed = await claimer.api.request("POST", "/v3/keys/claim", {
        body: { one_time_keys: { [bob.userId]: { [bob.deviceId]: "signed_curve25519" } } },
      });
    }
    const last = Object.values<any>(claimed.one_time_keys[bob.userId][bob.deviceId])[0];
    assert.equal(last.fallback, true);
    await bob.start();
    await bob.sendText(await bob.createRoom({}), "nudge again").catch(() => {});
    await until("a new fallback key", async () => (await fallbackKey()) !== before);
    assert.equal(
      JSON.parse((await bob.store.get<{ pickle: string }>("account", "account"))!.pickle).previous_fallback.public_key,
      before,
      "the used one is kept for messages in flight",
    );
  } finally {
    await t.close();
  }
});

test("interop through the server: our client and matrix-sdk-crypto (Element's Rust crypto) in one room", async () => {
  const t = await homeserver();
  const { CryptoClient } = await import("matrix-nodejs-homeserver/auditbot");
  const fetch = (await import("matrix-nodejs-homeserver")).getFetchHandler(t.hs);
  const userId = await t.hs.admin.createUser("rusty", { password: "password" });
  const session = await t.hs.auth.createSession(userId);
  const rusty = new CryptoClient({ fetch, userId, deviceId: session.device_id, accessToken: session.access_token });
  await rusty.open();
  try {
    await rusty.flush();
    const alice = await t.login("alice");
    await alice.start();
    await alice.waitForPrepared();
    const roomId = await alice.createRoom({ encrypted: true, invite: [userId] });
    await rusty.request("POST", `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {});
    await until("rusty joined", () => alice.getRoom(roomId)?.state.membership(userId) === "join");

    // Ours → Rust.
    const sentId = await alice.sendText(roomId, "from the TypeScript client");
    let since: string | undefined;
    const rustSync = async () => {
      const res: any = await rusty.request("GET", `/_matrix/client/v3/sync?timeout=0${since ? `&since=${since}` : ""}`);
      since = res.next_batch;
      await rusty.receiveSync(res);
      return res;
    };
    const decrypted = await until("rust decrypts", async () => {
      const res = await rustSync();
      const ev = res.rooms?.join?.[roomId]?.timeline?.events?.find((e: any) => e.event_id === sentId);
      if (!ev) return undefined;
      return JSON.parse((await rusty.decrypt(ev, roomId)).event);
    });
    assert.equal(decrypted.content.body, "from the TypeScript client");

    // Rust → ours.
    await rusty.sendEncrypted(roomId, [alice.userId, userId], { msgtype: "m.text", body: "from matrix-sdk-crypto" });
    const back = await until("we decrypt rust's message", () =>
      findEvent(alice, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "from matrix-sdk-crypto"),
    );
    assert.equal(back.sender, userId);
    assert.equal(back.decryptionInfo?.authenticity, "authenticated");
  } finally {
    rusty.close();
    await t.close();
  }
});
