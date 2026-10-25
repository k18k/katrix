import { test } from "node:test";
import assert from "node:assert/strict";
import { MatrixEvent } from "../../src/models/event.ts";
import { decodeUtf8 } from "@katrix/shared";
import { body, findEvent, homeserver, until } from "./helpers.ts";
import { RawPeer } from "./peer.ts";

// Attacks on the E2EE layer by a member of the room (Mallory, whose messages are hand-built) and
// by the server (replays). Each must fail closed: no plaintext, no false attribution, and the
// client keeps working.

async function setup() {
  const t = await homeserver();
  const alice = await t.login("alice");
  const bob = await t.login("bob");
  const mallory = new RawPeer(await t.login("mallory", { e2ee: false }));
  await mallory.uploadKeys();
  await alice.start();
  await bob.start();
  await alice.waitForPrepared();
  await bob.waitForPrepared();
  const roomId = await alice.createRoom({ encrypted: true, preset: "public_chat" });
  await bob.joinRoom(roomId);
  await mallory.client.joinRoom(roomId);
  await until(
    "members",
    () =>
      bob.getRoom(roomId)?.state.membership(mallory.userId) === "join" && alice.getRoom(roomId)?.state.membership(bob.userId) === "join",
  );
  return { t, alice, bob, mallory, roomId };
}

const failedWith = (code: string) => (e: MatrixEvent) => e.decryptionStatus === "failed" && e.decryptionError === code;

test("to-device payloads that name another sender, recipient or device key are dropped", async () => {
  const { t, bob, mallory, roomId } = await setup();
  try {
    const to = { userId: bob.userId, ed25519: "" };
    const cases: Array<[string, (ed: string) => Record<string, unknown>]> = [
      ["another recipient", () => ({ recipient: "@alice:localhost" })],
      ["another recipient key", () => ({ recipient_keys: { ed25519: mallory.keys.ed25519 } })],
      ["another sender", () => ({ sender: "@alice:localhost" })],
      ["another sender key", () => ({ keys: { ed25519: new RawPeer(mallory.client).keys.ed25519 } })],
    ];
    const eventIds: string[] = [];
    for (const [, override] of cases) {
      const group = mallory.protocol.newOutboundGroupSession();
      const { content } = await mallory.olmContent(bob.userId, bob.deviceId, (target) =>
        mallory.payload("m.room_key", mallory.roomKey(roomId, group), { ...to, ed25519: target.ed25519 }, override(target.ed25519)),
      );
      await mallory.sendToDevice(bob.userId, bob.deviceId, "m.room.encrypted", content);
      eventIds.push(
        await mallory.sendRoomEvent(
          roomId,
          mallory.megolmContent(group, { type: "m.room.message", content: { msgtype: "m.text", body: "x" }, room_id: roomId }),
        ),
      );
    }
    // A control message, honest in every field, does decrypt.
    const honest = mallory.protocol.newOutboundGroupSession();
    const { content } = await mallory.olmContent(bob.userId, bob.deviceId, (target) =>
      mallory.payload("m.room_key", mallory.roomKey(roomId, honest), { ...to, ed25519: target.ed25519 }),
    );
    await mallory.sendToDevice(bob.userId, bob.deviceId, "m.room.encrypted", content);
    await mallory.sendRoomEvent(
      roomId,
      mallory.megolmContent(honest, { type: "m.room.message", content: { msgtype: "m.text", body: "honest" }, room_id: roomId }),
    );
    const ok = await until("the honest message", () =>
      findEvent(bob, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "honest"),
    );
    assert.equal(ok.sender, mallory.userId);
    for (const id of eventIds) {
      const e = findEvent(bob, roomId, (x) => x.eventId === id)!;
      assert.ok(failedWith("MISSING_ROOM_KEY")(e), `${cases[eventIds.indexOf(id)][0]}: ${e.decryptionStatus} ${e.decryptionError}`);
    }
  } finally {
    await t.close();
  }
});

test("an unencrypted m.room_key is ignored", async () => {
  const { t, bob, mallory, roomId } = await setup();
  try {
    const group = mallory.protocol.newOutboundGroupSession();
    await mallory.sendToDevice(bob.userId, bob.deviceId, "m.room_key", mallory.roomKey(roomId, group));
    const id = await mallory.sendRoomEvent(
      roomId,
      mallory.megolmContent(group, { type: "m.room.message", content: { body: "plain key" }, room_id: roomId }),
    );
    const e = await until("the event", () => findEvent(bob, roomId, (x) => x.eventId === id && x.decryptionStatus === "failed"));
    assert.equal(e.decryptionError, "MISSING_ROOM_KEY");
  } finally {
    await t.close();
  }
});

test("a plaintext for another room is refused (ROOM_MISMATCH)", async () => {
  const { t, bob, mallory, roomId } = await setup();
  try {
    const group = mallory.protocol.newOutboundGroupSession();
    const { content } = await mallory.olmContent(bob.userId, bob.deviceId, (target) =>
      mallory.payload("m.room_key", mallory.roomKey(roomId, group), { userId: bob.userId, ed25519: target.ed25519 }),
    );
    await mallory.sendToDevice(bob.userId, bob.deviceId, "m.room.encrypted", content);
    const id = await mallory.sendRoomEvent(
      roomId,
      mallory.megolmContent(group, { type: "m.room.message", content: { body: "moved" }, room_id: "!elsewhere:localhost" }),
    );
    await until("refused", () => findEvent(bob, roomId, (x) => x.eventId === id && failedWith("ROOM_MISMATCH")(x)));
  } finally {
    await t.close();
  }
});

test("a server replaying a message as a new event is caught (REPLAYED); the original still decrypts", async () => {
  const { t, alice, bob, roomId } = await setup();
  try {
    await alice.sendText(roomId, "say it once");
    const original = await until("decrypted", () =>
      findEvent(bob, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "say it once"),
    );
    const again = new MatrixEvent({ ...original.wire });
    assert.ok(await bob.e2ee!.decryptRoomEvent(again), "the same event (ID and timestamp) decrypts again");
    const replay = new MatrixEvent({ ...original.wire, event_id: "$replayed", origin_server_ts: original.originServerTs! + 1000 });
    assert.equal(await bob.e2ee!.decryptRoomEvent(replay), false);
    assert.equal(replay.decryptionError, "REPLAYED");
    assert.equal(replay.type, "m.room.encrypted", "nothing of the plaintext is exposed");
  } finally {
    await t.close();
  }
});

test("a room key relayed by another member cannot make its sender look like the original one", async () => {
  // Mallory receives Alice's room key honestly, then hands it to Carol as her own before Alice's
  // copy arrives. Carol must not show Alice's messages as Alice's on Mallory's word, nor as
  // Mallory's: they fail with SENDER_MISMATCH.
  const { t, alice, bob, mallory, roomId } = await setup();
  try {
    const carol = await t.login("carol");
    await carol.start();
    await carol.waitForPrepared();
    await carol.joinRoom(roomId);
    await until("carol joined", () => alice.getRoom(roomId)?.state.membership(carol.userId) === "join");
    await carol.stop();

    await alice.sendText(roomId, "from alice");
    await until("bob decrypts", () => findEvent(bob, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "from alice"));
    // Mallory reads her to-device messages and decrypts Alice's room key.
    const sync: any = await mallory.client.api.request("GET", "/v3/sync", { query: { timeout: 0 } });
    const toMe = sync.to_device.events.find((e: any) => e.type === "m.room.encrypted" && e.sender === alice.userId);
    const { plaintext } = mallory.account.createInboundSession(toMe.content.sender_key, toMe.content.ciphertext[mallory.keys.curve25519]);
    const aliceKey = JSON.parse(decodeUtf8(plaintext)).content;
    assert.equal(aliceKey.type ?? "m.room_key", "m.room_key");
    const { content } = await mallory.olmContent(carol.userId, carol.deviceId, (target) =>
      mallory.payload("m.room_key", aliceKey, { userId: carol.userId, ed25519: target.ed25519 }),
    );
    // Mallory's copy must reach Carol first: send it before Carol syncs again; Alice's copy was
    // queued earlier, so hold Alice's back by having Carol process only Mallory's here.
    await mallory.sendToDevice(carol.userId, carol.deviceId, "m.room.encrypted", content);
    await carol.start();
    const e = await until("carol sees alice's message", () =>
      findEvent(
        carol,
        roomId,
        (x) => body(x) === "from alice" || (x.sender === alice.userId && x.isEncrypted() && x.decryptionStatus !== "pending"),
      ),
    );
    // Whichever copy Carol stored first, the message is never attributed to Mallory.
    if (e.decryptionStatus === "decrypted") {
      assert.equal(e.sender, alice.userId);
      assert.notEqual(e.decryptionInfo?.senderCurve25519Key, mallory.keys.curve25519);
    } else {
      assert.equal(e.decryptionError, "SENDER_MISMATCH");
    }
    const stored = await carol.store.get<{ senderUserId: string }>("inbound_group_sessions", `${roomId}|${aliceKey.session_id}`);
    assert.ok(stored);
    if (stored.senderUserId === mallory.userId) assert.equal(e.decryptionError, "SENDER_MISMATCH");
  } finally {
    await t.close();
  }
});

test("a replayed pre-key message does not start a second Olm session", async () => {
  const { t, bob, mallory, roomId } = await setup();
  try {
    const group = mallory.protocol.newOutboundGroupSession();
    const { content, message } = await mallory.olmContent(bob.userId, bob.deviceId, (target) =>
      mallory.payload("m.room_key", mallory.roomKey(roomId, group), { userId: bob.userId, ed25519: target.ed25519 }),
    );
    assert.equal(message.type, 0);
    await mallory.sendToDevice(bob.userId, bob.deviceId, "m.room.encrypted", content);
    await mallory.sendToDevice(bob.userId, bob.deviceId, "m.room.encrypted", content);
    await mallory.sendRoomEvent(
      roomId,
      mallory.megolmContent(group, { type: "m.room.message", content: { body: "after replay" }, room_id: roomId }),
    );
    await until("decrypted", () => findEvent(bob, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "after replay"));
    assert.equal((await bob.store.list("olm_sessions", `${mallory.keys.curve25519}|`)).length, 1);
  } finally {
    await t.close();
  }
});

test("an undecryptable Olm message makes the client start a new session and send m.dummy", async () => {
  const { t, bob, mallory } = await setup();
  try {
    // A normal message for a session Bob never had.
    const fake = {
      algorithm: "m.olm.v1.curve25519-aes-sha2",
      sender_key: mallory.keys.curve25519,
      ciphertext: {
        [(await mallory.sessionTo(bob.userId, bob.deviceId)).curve25519]: {
          type: 1,
          body: "AwogAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQACIQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    };
    await mallory.sendToDevice(bob.userId, bob.deviceId, "m.room.encrypted", fake);
    const dummy = await until("bob's m.dummy", async () => {
      const sync: any = await mallory.client.api.request("GET", "/v3/sync", { query: { timeout: 500 } });
      const ev = sync.to_device?.events?.find((e: any) => e.sender === bob.userId && e.type === "m.room.encrypted");
      if (!ev) return undefined;
      const m = ev.content.ciphertext[mallory.keys.curve25519];
      return JSON.parse(decodeUtf8(mallory.account.createInboundSession(ev.content.sender_key, m).plaintext));
    });
    assert.equal(dummy.type, "m.dummy");
    assert.equal(dummy.recipient, mallory.userId);
  } finally {
    await t.close();
  }
});

test("messages with low-order Curve25519 keys are rejected one by one; the sync goes on", async () => {
  const { t, bob, mallory, roomId } = await setup();
  try {
    const { curve25519 } = await mallory.sessionTo(bob.userId, bob.deviceId);
    const zero = new Uint8Array(32);
    const { WireWriter } = await import("../../src/protocol/wire.ts");
    const { encodeBase64 } = await import("@katrix/shared");
    // A pre-key message whose base key is the all-zero point.
    const inner = new WireWriter().byte(3).bytesField(0x0a, zero).varintField(0x10, 0).bytesField(0x22, new Uint8Array(16)).finish();
    const preKey = new WireWriter()
      .byte(3)
      .bytesField(0x0a, zero)
      .bytesField(0x12, zero)
      .bytesField(0x1a, zero)
      .bytesField(0x22, new Uint8Array([...inner, 0, 0, 0, 0, 0, 0, 0, 0]))
      .finish();
    await mallory.sendToDevice(bob.userId, bob.deviceId, "m.room.encrypted", {
      algorithm: "m.olm.v1.curve25519-aes-sha2",
      sender_key: encodeBase64(zero),
      ciphertext: { [curve25519]: { type: 0, body: encodeBase64(preKey) } },
    });
    // Then an honest key and message: they must still get through.
    const group = mallory.protocol.newOutboundGroupSession();
    const { content } = await mallory.olmContent(bob.userId, bob.deviceId, (target) =>
      mallory.payload("m.room_key", mallory.roomKey(roomId, group), { userId: bob.userId, ed25519: target.ed25519 }),
    );
    await mallory.sendToDevice(bob.userId, bob.deviceId, "m.room.encrypted", content);
    await mallory.sendRoomEvent(
      roomId,
      mallory.megolmContent(group, { type: "m.room.message", content: { body: "after the bad one" }, room_id: roomId }),
    );
    await until("the honest message decrypts", () =>
      findEvent(bob, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "after the bad one"),
    );
  } finally {
    await t.close();
  }
});

test("a corrupted session in storage fails only its own messages", async () => {
  const { t, alice, bob, mallory, roomId } = await setup();
  try {
    const group = mallory.protocol.newOutboundGroupSession();
    const { content } = await mallory.olmContent(bob.userId, bob.deviceId, (target) =>
      mallory.payload("m.room_key", mallory.roomKey(roomId, group), { userId: bob.userId, ed25519: target.ed25519 }),
    );
    await mallory.sendToDevice(bob.userId, bob.deviceId, "m.room.encrypted", content);
    await mallory.sendRoomEvent(roomId, mallory.megolmContent(group, { type: "m.room.message", content: { body: "m1" }, room_id: roomId }));
    await until("m1", () => findEvent(bob, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "m1"));
    await bob.store.transaction(async (tx) => {
      const key = `${roomId}|${group.sessionId()}`;
      const rec = await tx.get<Record<string, unknown>>("inbound_group_sessions", key);
      tx.put("inbound_group_sessions", key, { ...rec, pickle: '{"format":"mnc-pickle-1","kind":"megolm_inbound","initial":"!!"}' });
    });
    const id = await mallory.sendRoomEvent(
      roomId,
      mallory.megolmContent(group, { type: "m.room.message", content: { body: "m2" }, room_id: roomId }),
    );
    await until("m2 fails", () => findEvent(bob, roomId, (e) => e.eventId === id && e.decryptionStatus === "failed"));
    await alice.sendText(roomId, "still works");
    await until("other sessions still decrypt", () =>
      findEvent(bob, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === "still works"),
    );
  } finally {
    await t.close();
  }
});
