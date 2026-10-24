import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceId, DeviceLists, EncryptionSettings, OlmMachine, RoomId, UserId } from "@matrix-org/matrix-sdk-crypto-nodejs";
import { nobleCryptoPrimitives } from "../../src/crypto/noble.ts";
import { nativeE2EEProtocol } from "../../src/protocol/native.ts";
import type { OlmAccount } from "../../src/protocol/protocol.ts";
import { canonicalJson, signingJson } from "../../src/util/canonical-json.ts";
import { decodeUtf8, encodeUtf8 } from "../../src/util/utf8.ts";

// Interoperability of the built-in Olm and Megolm with vodozemac, the reference implementation
// (through matrix-sdk-crypto, the crypto of the Element apps). Messages go both ways, so the wire
// formats, key derivations and signatures must agree byte for byte.

const protocol = nativeE2EEProtocol(nobleCryptoPrimitives());
const ALICE = "@alice:localhost";
const ALICE_DEVICE = "ALICEDEVICE";
const BOB = "@bob:localhost";
const BOB_DEVICE = "BOBDEVICE";
const ROOM = "!room:localhost";
const Req = { KeysUpload: 0, KeysQuery: 1, KeysClaim: 2, ToDevice: 3 } as const;

function signed(account: OlmAccount, obj: Record<string, unknown>) {
  return { ...obj, signatures: { [ALICE]: { [`ed25519:${ALICE_DEVICE}`]: account.sign(signingJson(obj)) } } };
}

function aliceDeviceKeys(account: OlmAccount) {
  const ik = account.identityKeys();
  return signed(account, {
    user_id: ALICE,
    device_id: ALICE_DEVICE,
    algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
    keys: { [`curve25519:${ALICE_DEVICE}`]: ik.curve25519, [`ed25519:${ALICE_DEVICE}`]: ik.ed25519 },
  });
}

/** Bob: a matrix-sdk-crypto machine that knows Alice's device. Returns his uploaded keys too. */
async function bobMachine(account: OlmAccount) {
  const machine = await OlmMachine.initialize(new UserId(BOB), new DeviceId(BOB_DEVICE));
  let upload: any;
  for (const r of await machine.outgoingRequests()) {
    if ((r.type as number) === Req.KeysUpload) {
      upload = JSON.parse(r.body);
      await machine.markRequestAsSent(r.id, r.type, JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } }));
    }
  }
  await machine.updateTrackedUsers([new UserId(ALICE)]);
  for (const r of await machine.outgoingRequests()) {
    if ((r.type as number) === Req.KeysQuery) {
      await machine.markRequestAsSent(
        r.id,
        r.type,
        JSON.stringify({ device_keys: { [ALICE]: { [ALICE_DEVICE]: aliceDeviceKeys(account) } }, failures: {} }),
      );
    }
  }
  return { machine, upload };
}

function olmPayload(account: OlmAccount, bobEd25519: string, type: string, content: unknown) {
  return encodeUtf8(
    JSON.stringify({
      type,
      content,
      sender: ALICE,
      sender_device: ALICE_DEVICE,
      keys: { ed25519: account.identityKeys().ed25519 },
      recipient: BOB,
      recipient_keys: { ed25519: bobEd25519 },
    }),
  );
}

test("vodozemac decrypts our Olm pre-key message and then our Megolm messages", async () => {
  const alice = protocol.newAccount();
  const { machine, upload } = await bobMachine(alice);
  try {
    const bobCurve = upload.device_keys.keys[`curve25519:${BOB_DEVICE}`];
    const bobEd = upload.device_keys.keys[`ed25519:${BOB_DEVICE}`];
    const [otkId, otk] = Object.entries<any>(upload.one_time_keys)[0];
    assert.match(otkId, /^signed_curve25519:/);
    // Bob's one-time key is signed by his device key over its canonical JSON.
    assert.ok(protocol.verifyEd25519(bobEd, signingJson(otk), otk.signatures[BOB][`ed25519:${BOB_DEVICE}`]));

    const session = alice.createOutboundSession(bobCurve, otk.key);
    const group = protocol.newOutboundGroupSession();
    const roomKey = { algorithm: "m.megolm.v1.aes-sha2", room_id: ROOM, session_id: group.sessionId(), session_key: group.sessionKey() };
    const message = session.encrypt(olmPayload(alice, bobEd, "m.room_key", roomKey));
    assert.equal(message.type, 0);
    const toDevice = {
      type: "m.room.encrypted",
      sender: ALICE,
      content: {
        algorithm: "m.olm.v1.curve25519-aes-sha2",
        sender_key: alice.identityKeys().curve25519,
        ciphertext: { [bobCurve]: message },
      },
    };
    const processed = JSON.parse(
      await machine.receiveSyncChanges(JSON.stringify([toDevice]), new DeviceLists([], []), { signed_curve25519: 49 }, []),
    );
    const events = Array.isArray(processed) ? processed : (processed.events ?? processed);
    assert.ok(JSON.stringify(events).includes("m.room_key"), "the room key arrives decrypted");

    for (let i = 0; i < 3; i++) {
      const body = `hello ${i} — zażółć gęślą jaźń 🦀`;
      const ciphertext = group.encrypt(
        encodeUtf8(JSON.stringify({ type: "m.room.message", content: { msgtype: "m.text", body }, room_id: ROOM })),
      );
      const event = {
        type: "m.room.encrypted",
        event_id: `$e${i}`,
        sender: ALICE,
        origin_server_ts: Date.now(),
        room_id: ROOM,
        content: {
          algorithm: "m.megolm.v1.aes-sha2",
          sender_key: alice.identityKeys().curve25519,
          device_id: ALICE_DEVICE,
          session_id: group.sessionId(),
          ciphertext,
        },
      };
      const decrypted = await machine.decryptRoomEvent(JSON.stringify(event), new RoomId(ROOM));
      assert.equal(JSON.parse(decrypted.event).content.body, body);
      assert.equal(decrypted.senderCurve25519Key, alice.identityKeys().curve25519);
      assert.equal(decrypted.senderClaimedEd25519Key, alice.identityKeys().ed25519);
    }
  } finally {
    machine.close();
  }
});

test("vodozemac follows our Megolm ratchet past the 2^16 boundary (advance_to against our steps)", async () => {
  const alice = protocol.newAccount();
  const { machine, upload } = await bobMachine(alice);
  try {
    const bobCurve = upload.device_keys.keys[`curve25519:${BOB_DEVICE}`];
    const bobEd = upload.device_keys.keys[`ed25519:${BOB_DEVICE}`];
    const otk = Object.values<any>(upload.one_time_keys)[0];
    const group = protocol.newOutboundGroupSession();
    const message = alice.createOutboundSession(bobCurve, otk.key).encrypt(
      olmPayload(alice, bobEd, "m.room_key", {
        algorithm: "m.megolm.v1.aes-sha2",
        room_id: ROOM,
        session_id: group.sessionId(),
        session_key: group.sessionKey(),
      }),
    );
    const toDevice = {
      type: "m.room.encrypted",
      sender: ALICE,
      content: {
        algorithm: "m.olm.v1.curve25519-aes-sha2",
        sender_key: alice.identityKeys().curve25519,
        ciphertext: { [bobCurve]: message },
      },
    };
    await machine.receiveSyncChanges(JSON.stringify([toDevice]), new DeviceLists([], []), {}, []);
    // Bob got the key at index 0; we step to just past 2^16 (R_2 rehashed, R_3 reset).
    let ciphertext = "";
    while (group.messageIndex() < 65537)
      ciphertext = group.encrypt(
        encodeUtf8(JSON.stringify({ type: "m.room.message", content: { body: `i${group.messageIndex()}` }, room_id: ROOM })),
      );
    const event = {
      type: "m.room.encrypted",
      event_id: "$far",
      sender: ALICE,
      origin_server_ts: Date.now(),
      room_id: ROOM,
      content: {
        algorithm: "m.megolm.v1.aes-sha2",
        sender_key: alice.identityKeys().curve25519,
        session_id: group.sessionId(),
        ciphertext,
      },
    };
    const decrypted = await machine.decryptRoomEvent(JSON.stringify(event), new RoomId(ROOM));
    assert.equal(JSON.parse(decrypted.event).content.body, "i65536");
  } finally {
    machine.close();
  }
});

test("we decrypt vodozemac's Olm pre-key message (room key) and its Megolm messages", async () => {
  const alice = protocol.newAccount();
  alice.generateOneTimeKeys(1);
  const [keyId, key] = Object.entries(alice.oneTimeKeys())[0];
  alice.markKeysAsPublished();
  const { machine } = await bobMachine(alice);
  try {
    const claim = await machine.getMissingSessions([new UserId(ALICE)]);
    assert.ok(claim);
    const otk = { [`signed_curve25519:${keyId}`]: signed(alice, { key }) };
    await machine.markRequestAsSent(
      claim.id,
      claim.type,
      JSON.stringify({ one_time_keys: { [ALICE]: { [ALICE_DEVICE]: otk } }, failures: {} }),
    );
    const requests = await machine.shareRoomKey(new RoomId(ROOM), [new UserId(ALICE)], new EncryptionSettings());
    assert.equal(requests.length, 1);
    const content = JSON.parse(requests[0].body).messages[ALICE][ALICE_DEVICE];
    assert.equal(content.algorithm, "m.olm.v1.curve25519-aes-sha2");
    const message = content.ciphertext[alice.identityKeys().curve25519];
    assert.equal(message.type, 0);
    const { session, plaintext } = alice.createInboundSession(content.sender_key, message);
    const payload = JSON.parse(decodeUtf8(plaintext));
    assert.equal(payload.type, "m.room_key");
    assert.equal(payload.recipient, ALICE);
    assert.equal(payload.recipient_keys.ed25519, alice.identityKeys().ed25519);
    // The one-time key is used up.
    assert.equal(Object.keys(alice.oneTimeKeys()).length, 0);
    assert.ok(session.sessionId());

    const inbound = protocol.inboundGroupSessionFromSessionKey(payload.content.session_key);
    assert.equal(inbound.sessionId(), payload.content.session_id);
    for (let i = 0; i < 3; i++) {
      const encrypted = JSON.parse(
        await machine.encryptRoomEvent(new RoomId(ROOM), "m.room.message", JSON.stringify({ msgtype: "m.text", body: `from rust ${i}` })),
      );
      assert.equal(encrypted.session_id, inbound.sessionId());
      const { plaintext: clear, messageIndex } = inbound.decrypt(encrypted.ciphertext);
      assert.equal(messageIndex, i);
      const event = JSON.parse(decodeUtf8(clear));
      assert.deepEqual(event, { type: "m.room.message", content: { msgtype: "m.text", body: `from rust ${i}` }, room_id: ROOM });
    }
  } finally {
    machine.close();
  }
});

test("an Olm conversation with vodozemac ratchets in both directions", async () => {
  const alice = protocol.newAccount();
  const { machine, upload } = await bobMachine(alice);
  try {
    const bobCurve = upload.device_keys.keys[`curve25519:${BOB_DEVICE}`];
    const bobEd = upload.device_keys.keys[`ed25519:${BOB_DEVICE}`];
    const otk = Object.values<any>(upload.one_time_keys)[0];
    const session = alice.createOutboundSession(bobCurve, otk.key);
    const send = async (type: string, content: unknown) => {
      const m = session.encrypt(olmPayload(alice, bobEd, type, content));
      const ev = {
        type: "m.room.encrypted",
        sender: ALICE,
        content: { algorithm: "m.olm.v1.curve25519-aes-sha2", sender_key: alice.identityKeys().curve25519, ciphertext: { [bobCurve]: m } },
      };
      return JSON.stringify(JSON.parse(await machine.receiveSyncChanges(JSON.stringify([ev]), new DeviceLists([], []), {}, [])));
    };
    // Alice → Bob: the pre-key message that starts the session.
    const g1 = protocol.newOutboundGroupSession();
    assert.match(
      await send("m.room_key", {
        algorithm: "m.megolm.v1.aes-sha2",
        room_id: ROOM,
        session_id: g1.sessionId(),
        session_key: g1.sessionKey(),
      }),
      /m\.room_key/,
    );

    // Bob → Alice on the existing session: matrix-sdk-crypto reuses it (a normal message).
    const requests = await machine.shareRoomKey(new RoomId(ROOM), [new UserId(ALICE)], new EncryptionSettings());
    const content = JSON.parse(requests[0].body).messages[ALICE][ALICE_DEVICE];
    const reply = content.ciphertext[alice.identityKeys().curve25519];
    assert.equal(reply.type, 1, "Bob answers on the session Alice started");
    const payload = JSON.parse(decodeUtf8(session.decrypt(reply)));
    assert.equal(payload.type, "m.room_key");
    assert.ok(session.hasReceivedMessage());

    // Alice now sends normal messages on a new chain, and one of them is lost: vodozemac must
    // follow the ratchet step and skip the lost message's key.
    const g2 = protocol.newOutboundGroupSession();
    const lost = session.encrypt(encodeUtf8("{}"));
    assert.equal(lost.type, 1);
    assert.match(
      await send("m.room_key", {
        algorithm: "m.megolm.v1.aes-sha2",
        room_id: "!other:localhost",
        session_id: g2.sessionId(),
        session_key: g2.sessionKey(),
      }),
      new RegExp(g2.sessionId().replace(/[+/]/g, "\\$&")),
    );
  } finally {
    machine.close();
  }
});

test("canonical JSON of a device key object matches what matrix-sdk-crypto signs", async () => {
  const { machine, upload } = await bobMachine(protocol.newAccount());
  try {
    const keys = upload.device_keys;
    const ed = keys.keys[`ed25519:${BOB_DEVICE}`];
    assert.ok(protocol.verifyEd25519(ed, signingJson(keys), keys.signatures[BOB][`ed25519:${BOB_DEVICE}`]));
    // Any change to the signed content breaks the signature.
    assert.ok(
      !protocol.verifyEd25519(
        ed,
        canonicalJson({ ...keys, signatures: undefined, device_id: "OTHER" }),
        keys.signatures[BOB][`ed25519:${BOB_DEVICE}`],
      ),
    );
  } finally {
    machine.close();
  }
});
