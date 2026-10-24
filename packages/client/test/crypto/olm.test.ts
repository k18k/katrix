import { test } from "node:test";
import assert from "node:assert/strict";
import { nobleCryptoPrimitives } from "../../src/crypto/noble.ts";
import { MAX_MESSAGE_GAP, MAX_SKIPPED_MESSAGE_KEYS } from "../../src/protocol/olm/ratchet.ts";
import { nativeE2EEProtocol } from "../../src/protocol/native.ts";
import { ProtocolError, type OlmMessage, type OlmSession } from "../../src/protocol/protocol.ts";
import { decodeBase64, encodeBase64 } from "../../src/util/base64.ts";
import { decodeUtf8, encodeUtf8 } from "../../src/util/utf8.ts";

const primitives = nobleCryptoPrimitives();
const protocol = nativeE2EEProtocol(primitives);
const text = (b: Uint8Array) => decodeUtf8(b);
const bytes = (s: string) => encodeUtf8(s);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ProtocolError, `expected a ProtocolError, got ${e}`);
    return e.code;
  }
  assert.fail("expected an error");
}

/** Alice starts a session with Bob; Bob answers once, so both sides have ratcheted. */
function pair(opts: { answer?: boolean } = {}) {
  const alice = protocol.newAccount();
  const bob = protocol.newAccount();
  bob.generateOneTimeKeys(1);
  const otk = Object.values(bob.oneTimeKeys())[0];
  bob.markKeysAsPublished();
  const a = alice.createOutboundSession(bob.identityKeys().curve25519, otk);
  const first = a.encrypt(bytes("first"));
  const { session: b, plaintext } = bob.createInboundSession(alice.identityKeys().curve25519, first);
  assert.equal(text(plaintext), "first");
  if (opts.answer !== false) assert.equal(text(a.decrypt(b.encrypt(bytes("answer")))), "answer");
  return { alice, bob, a, b };
}

function flip(m: OlmMessage, at: (len: number) => number): OlmMessage {
  const raw = decodeBase64(m.body);
  raw[at(raw.length)] ^= 0x01;
  return { type: m.type, body: encodeBase64(raw) };
}

test("a conversation: pre-key messages until the first answer, then normal ones, many ratchet steps", () => {
  const alice = protocol.newAccount();
  const bob = protocol.newAccount();
  bob.generateOneTimeKeys(2);
  const otk = Object.values(bob.oneTimeKeys())[0];
  const a = alice.createOutboundSession(bob.identityKeys().curve25519, otk);
  const m1 = a.encrypt(bytes("1"));
  const m2 = a.encrypt(bytes("2"));
  assert.equal(m1.type, 0);
  assert.equal(m2.type, 0, "still a pre-key message: Bob has not answered");
  const { session: b } = bob.createInboundSession(alice.identityKeys().curve25519, m1);
  assert.equal(b.sessionId(), a.sessionId());
  assert.ok(b.sessionMatches(m2));
  assert.equal(text(b.decrypt(m2)), "2");
  for (let round = 0; round < 20; round++) {
    const fromBob = b.encrypt(bytes(`b${round}`));
    assert.equal(fromBob.type, 1);
    assert.equal(text(a.decrypt(fromBob)), `b${round}`);
    const fromAlice = a.encrypt(bytes(`a${round}`));
    assert.equal(fromAlice.type, 1, "normal messages once Alice has received");
    assert.equal(text(b.decrypt(fromAlice)), `a${round}`);
  }
  // Long plaintexts and every padding length.
  for (let n = 0; n < 40; n++) assert.equal(text(b.decrypt(a.encrypt(bytes("x".repeat(n * 7))))), "x".repeat(n * 7));
});

test("messages out of order decrypt, within a chain and across ratchet steps", () => {
  const { a, b } = pair();
  const batch = [0, 1, 2, 3, 4].map((i) => a.encrypt(bytes(`m${i}`)));
  for (const i of [3, 0, 4, 2, 1]) assert.equal(text(b.decrypt(batch[i])), `m${i}`);
  // Bob answers twice, Alice's next chain starts; an old-chain message still decrypts after.
  const late = a.encrypt(bytes("late"));
  a.decrypt(b.encrypt(bytes("r1")));
  const next = a.encrypt(bytes("new chain"));
  assert.equal(text(b.decrypt(next)), "new chain");
  assert.equal(text(b.decrypt(late)), "late");
});

test("a replayed message is refused, and the session still works after", () => {
  const { a, b } = pair();
  const m = a.encrypt(bytes("once"));
  assert.equal(text(b.decrypt(m)), "once");
  assert.equal(
    code(() => b.decrypt(m)),
    "BAD_MESSAGE_KEY_ID",
  );
  // A skipped key is also usable only once.
  const m1 = a.encrypt(bytes("1"));
  const m2 = a.encrypt(bytes("2"));
  b.decrypt(m2);
  b.decrypt(m1);
  assert.equal(
    code(() => b.decrypt(m1)),
    "BAD_MESSAGE_KEY_ID",
  );
  assert.equal(text(b.decrypt(a.encrypt(bytes("still fine")))), "still fine");
});

test("tampered messages fail the MAC and leave the session unchanged", () => {
  const { a, b } = pair();
  const m = a.encrypt(bytes("integrity"));
  // A flipped bit in the ciphertext, in the MAC, in the chain index.
  assert.equal(
    code(() => b.decrypt(flip(m, (n) => n - 12))),
    "BAD_MESSAGE_MAC",
  );
  assert.equal(
    code(() => b.decrypt(flip(m, (n) => n - 1))),
    "BAD_MESSAGE_MAC",
  );
  const counterAt = 1 + 2 + 32 + 1; // version, ratchet key tag+len, key, index tag
  assert.notEqual(
    code(() => b.decrypt(flip(m, () => counterAt))),
    "",
  );
  // The genuine message still decrypts: nothing was advanced by the failures.
  assert.equal(text(b.decrypt(m)), "integrity");
});

test("malformed messages: wrong version, truncation, bad Base64, unknown type", () => {
  const { a, b } = pair();
  const m = a.encrypt(bytes("x"));
  const raw = decodeBase64(m.body);
  const v = raw.slice();
  v[0] = 0x02;
  assert.equal(
    code(() => b.decrypt({ type: 1, body: encodeBase64(v) })),
    "BAD_MESSAGE_VERSION",
  );
  assert.equal(
    code(() => b.decrypt({ type: 1, body: encodeBase64(raw.subarray(0, 20)) })),
    "BAD_MESSAGE_FORMAT",
  );
  assert.equal(
    code(() => b.decrypt({ type: 1, body: encodeBase64(raw.subarray(0, 5)) })),
    "BAD_MESSAGE_FORMAT",
  );
  assert.equal(
    code(() => b.decrypt({ type: 1, body: "not base64!" })),
    "BAD_MESSAGE_FORMAT",
  );
  assert.equal(
    code(() => b.decrypt({ type: 2 as 1, body: m.body })),
    "BAD_MESSAGE_FORMAT",
  );
  assert.equal(
    code(() => b.decrypt({ type: 1, body: "" })),
    "BAD_MESSAGE_FORMAT",
  );
  assert.equal(text(b.decrypt(m)), "x");
});

test("skipped keys are capped, and a chain may jump at most MAX_MESSAGE_GAP ahead", () => {
  const { a, b } = pair();
  const skipped: OlmMessage[] = [];
  for (let i = 0; i < MAX_SKIPPED_MESSAGE_KEYS + 5; i++) skipped.push(a.encrypt(bytes(`s${i}`)));
  b.decrypt(a.encrypt(bytes("ahead")));
  // The oldest skipped keys were dropped; the newest are kept.
  assert.equal(
    code(() => b.decrypt(skipped[0])),
    "BAD_MESSAGE_KEY_ID",
  );
  assert.equal(text(b.decrypt(skipped[skipped.length - 1])), `s${skipped.length - 1}`);

  const { a: a2, b: b2 } = pair();
  for (let i = 0; i < MAX_MESSAGE_GAP + 1; i++) a2.encrypt(bytes(""));
  assert.equal(
    code(() => b2.decrypt(a2.encrypt(bytes("too far")))),
    "MESSAGE_GAP_TOO_LARGE",
  );
});

test("pre-key messages: one-time keys are used once, fallback keys stay, mismatches are refused", () => {
  const alice = protocol.newAccount();
  const bob = protocol.newAccount();
  bob.generateOneTimeKeys(1);
  bob.generateFallbackKey();
  const otk = Object.values(bob.oneTimeKeys())[0];
  const fallback = Object.values(bob.fallbackKey())[0];
  bob.markKeysAsPublished();
  assert.deepEqual(bob.oneTimeKeys(), {});

  const m = alice.createOutboundSession(bob.identityKeys().curve25519, otk).encrypt(bytes("otk"));
  // From the wrong identity key: refused, and the key is not used up.
  assert.equal(
    code(() => bob.createInboundSession(protocol.newAccount().identityKeys().curve25519, m)),
    "SESSION_MISMATCH",
  );
  bob.createInboundSession(alice.identityKeys().curve25519, m);
  // Used up: the same pre-key message cannot start a second session.
  assert.equal(
    code(() => bob.createInboundSession(alice.identityKeys().curve25519, m)),
    "UNKNOWN_ONE_TIME_KEY",
  );

  const f1 = alice.createOutboundSession(bob.identityKeys().curve25519, fallback).encrypt(bytes("fb1"));
  const f2 = alice.createOutboundSession(bob.identityKeys().curve25519, fallback).encrypt(bytes("fb2"));
  assert.equal(text(bob.createInboundSession(alice.identityKeys().curve25519, f1).plaintext), "fb1");
  assert.equal(text(bob.createInboundSession(alice.identityKeys().curve25519, f2).plaintext), "fb2");
  // The previous fallback key keeps working after a new one is made, until it is forgotten.
  bob.generateFallbackKey();
  const f3 = alice.createOutboundSession(bob.identityKeys().curve25519, fallback).encrypt(bytes("fb3"));
  assert.equal(text(bob.createInboundSession(alice.identityKeys().curve25519, f3).plaintext), "fb3");
  assert.ok(bob.forgetFallbackKey());
  const f4 = alice.createOutboundSession(bob.identityKeys().curve25519, fallback).encrypt(bytes("fb4"));
  assert.equal(
    code(() => bob.createInboundSession(alice.identityKeys().curve25519, f4)),
    "UNKNOWN_ONE_TIME_KEY",
  );

  // A pre-key message whose embedded message was tampered does not use up the key.
  bob.generateOneTimeKeys(1);
  const otk2 = Object.values(bob.oneTimeKeys())[0];
  const good = alice.createOutboundSession(bob.identityKeys().curve25519, otk2).encrypt(bytes("good"));
  assert.equal(
    code(() =>
      bob.createInboundSession(
        alice.identityKeys().curve25519,
        flip(good, (n) => n - 3),
      ),
    ),
    "BAD_MESSAGE_MAC",
  );
  assert.equal(text(bob.createInboundSession(alice.identityKeys().curve25519, good).plaintext), "good");
});

test("sessionMatches tells sessions apart; a normal message never starts a session", () => {
  const { alice, bob, a, b } = pair({ answer: false });
  const other = protocol.newAccount();
  bob.generateOneTimeKeys(1);
  const otherPreKey = other.createOutboundSession(bob.identityKeys().curve25519, Object.values(bob.oneTimeKeys())[0]).encrypt(bytes("x"));
  assert.ok(b.sessionMatches(a.encrypt(bytes("y"))));
  assert.ok(!b.sessionMatches(otherPreKey));
  assert.equal(
    code(() => b.decrypt(otherPreKey)),
    "SESSION_MISMATCH",
  );
  const normal = b.encrypt(bytes("n"));
  assert.ok(!a.sessionMatches(normal));
  assert.equal(
    code(() => alice.createInboundSession(bob.identityKeys().curve25519, normal)),
    "BAD_MESSAGE_FORMAT",
  );
});

test("a pre-key message for another account cannot be opened by an eavesdropper", () => {
  // Eve knows Bob's public keys, not his secrets: her session derives other keys than Bob's.
  const alice = protocol.newAccount();
  const bob = protocol.newAccount();
  const eve = protocol.newAccount();
  bob.generateOneTimeKeys(1);
  const otk = Object.values(bob.oneTimeKeys())[0];
  const toBob = alice.createOutboundSession(bob.identityKeys().curve25519, otk).encrypt(bytes("for bob"));
  eve.generateOneTimeKeys(1);
  assert.equal(
    code(() => eve.createInboundSession(alice.identityKeys().curve25519, toBob)),
    "UNKNOWN_ONE_TIME_KEY",
  );
});

test("identity keys sign; malformed keys are refused", () => {
  const acc = protocol.newAccount();
  const sig = acc.sign("canonical json");
  assert.ok(protocol.verifyEd25519(acc.identityKeys().ed25519, "canonical json", sig));
  assert.ok(!protocol.verifyEd25519(acc.identityKeys().ed25519, "canonical jsoN", sig));
  assert.ok(!protocol.verifyEd25519("bad key", "x", sig));
  assert.equal(
    code(() => acc.createOutboundSession("AAAA", acc.identityKeys().curve25519)),
    "BAD_PUBLIC_KEY",
  );
  assert.equal(
    code(() => acc.createOutboundSession(acc.identityKeys().curve25519, "!!")),
    "BAD_PUBLIC_KEY",
  );
});

test("one-time keys: capped, oldest dropped, published ones not listed", () => {
  const acc = protocol.newAccount();
  assert.equal(acc.maxNumberOfOneTimeKeys(), 50);
  acc.generateOneTimeKeys(30);
  const first = Object.keys(acc.oneTimeKeys());
  assert.equal(first.length, 30);
  assert.equal(first[0], "AAAAAQ", "libolm's key ID format");
  acc.markKeysAsPublished();
  acc.generateOneTimeKeys(90);
  assert.equal(Object.keys(acc.oneTimeKeys()).length, 90);
  // 120 generated, 100 kept: the first 20 (published ones) were dropped.
  const pickled = JSON.parse(acc.pickle());
  assert.equal(pickled.one_time_keys.length, 100);
});

test("pickles round-trip; encrypted pickles need the right key; corrupted ones are refused", () => {
  const { alice, a, b } = pair();
  const key = primitives.randomBytes(32);
  const restore = (s: OlmSession, k?: Uint8Array) => protocol.sessionFromPickle(s.pickle(k), k);

  const a2 = restore(a);
  const b2 = restore(b, key);
  assert.equal(text(b2.decrypt(a2.encrypt(bytes("after restore")))), "after restore");
  assert.deepEqual(protocol.accountFromPickle(alice.pickle(key), key).identityKeys(), alice.identityKeys());

  const encrypted = b2.pickle(key);
  assert.ok(encrypted.startsWith("e1:"));
  assert.ok(!encrypted.includes("root_key"), "an encrypted pickle shows nothing of the state");
  assert.equal(
    code(() => protocol.sessionFromPickle(encrypted, primitives.randomBytes(32))),
    "BAD_PICKLE_KEY",
  );
  assert.equal(
    code(() => protocol.sessionFromPickle(encrypted)),
    "BAD_PICKLE_KEY",
  );
  assert.equal(
    code(() => protocol.sessionFromPickle(b2.pickle(), key)),
    "BAD_PICKLE_KEY",
    "no silent downgrade to plaintext",
  );
  const raw = decodeBase64(encrypted.slice(3));
  raw[20] ^= 1;
  assert.equal(
    code(() => protocol.sessionFromPickle("e1:" + encodeBase64(raw), key)),
    "BAD_PICKLE_KEY",
  );
  assert.equal(
    code(() => protocol.sessionFromPickle("{not json", undefined)),
    "BAD_PICKLE",
  );
  assert.equal(
    code(() => protocol.sessionFromPickle(alice.pickle())),
    "BAD_PICKLE",
    "an account pickle is not a session pickle",
  );

  const plain = JSON.parse(a2.pickle());
  plain.ratchet.root_key = "AAAA";
  assert.equal(
    code(() => protocol.sessionFromPickle(JSON.stringify(plain))),
    "BAD_PICKLE",
  );
  const acc = JSON.parse(alice.pickle());
  acc.ed25519.public_key = protocol.newAccount().identityKeys().ed25519;
  assert.equal(
    code(() => protocol.accountFromPickle(JSON.stringify(acc))),
    "BAD_PICKLE",
    "keys that do not belong together",
  );
  // Errors never echo state.
  try {
    protocol.sessionFromPickle(JSON.stringify(plain));
  } catch (e) {
    assert.ok(!String((e as Error).message).includes(plain.ratchet.receiver_chains[0]?.chain_key?.key ?? "§"));
  }
});

test("low-order Curve25519 keys in messages are protocol errors, not internal ones", async () => {
  const { WireWriter } = await import("../../src/protocol/wire.ts");
  const { bob, b } = pair();
  const zero = new Uint8Array(32);
  // A normal message on a new chain with the all-zero ratchet key.
  const normal = new WireWriter().byte(3).bytesField(0x0a, zero).varintField(0x10, 0).bytesField(0x22, new Uint8Array(16)).finish();
  const withMac = new Uint8Array([...normal, 0, 0, 0, 0, 0, 0, 0, 0]);
  b.encrypt(bytes("so that Bob has a sender chain"));
  assert.equal(
    code(() => b.decrypt({ type: 1, body: encodeBase64(withMac) })),
    "BAD_PUBLIC_KEY",
  );
  // A pre-key message with an all-zero base key, for one of Bob's real one-time keys.
  bob.generateOneTimeKeys(1);
  const otk = decodeBase64(Object.values(bob.oneTimeKeys())[0]);
  const preKey = new WireWriter()
    .byte(3)
    .bytesField(0x0a, otk)
    .bytesField(0x12, zero)
    .bytesField(0x1a, zero)
    .bytesField(0x22, withMac)
    .finish();
  assert.equal(
    code(() => bob.createInboundSession(encodeBase64(zero), { type: 0, body: encodeBase64(preKey) })),
    "BAD_PUBLIC_KEY",
  );
  assert.equal(Object.keys(bob.oneTimeKeys()).length, 1, "the key is not used up");
});
