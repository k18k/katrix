import { test } from "node:test";
import assert from "node:assert/strict";
import { nobleCryptoPrimitives } from "../../src/crypto/noble.ts";
import { advance, advanceTo, copyRatchet, ratchetBytes, ratchetFromBytes } from "../../src/protocol/megolm/ratchet.ts";
import { nativeE2EEProtocol } from "../../src/protocol/native.ts";
import { ProtocolError } from "../../src/protocol/protocol.ts";
import { decodeBase64, encodeBase64 } from "../../src/util/base64.ts";
import { concatBytes, toHex } from "../../src/util/bytes.ts";
import { decodeUtf8, encodeUtf8 } from "../../src/util/utf8.ts";

const p = nobleCryptoPrimitives();
const protocol = nativeE2EEProtocol(p);
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

test("the ratchet: advanceTo agrees with stepping, across every part boundary", () => {
  // Counters just below the points where R_3, R_2, R_1 and R_0 are rehashed (2^8, 2^16, 2^24, 2^32).
  for (const start of [0, 250, 0xfff0, 0xfffff0, 0xfffffff0 - 16, 0x01fffffa, 0x00ff00f0]) {
    const base = ratchetFromBytes(p.randomBytes(128), start);
    const stepped = copyRatchet(base);
    for (let i = 1; i <= 24; i++) {
      advance(p, stepped);
      const jumped = copyRatchet(base);
      advanceTo(p, jumped, start + i);
      assert.equal(jumped.counter, (start + i) >>> 0);
      assert.equal(toHex(ratchetBytes(jumped)), toHex(ratchetBytes(stepped)), `start ${start} + ${i}`);
    }
  }
  // Large jumps equal a chain of smaller ones.
  const base = ratchetFromBytes(p.randomBytes(128), 5);
  const one = copyRatchet(base);
  advanceTo(p, one, 0x02030405);
  const two = copyRatchet(base);
  advanceTo(p, two, 0x00ffffff);
  advanceTo(p, two, 0x01000000);
  advanceTo(p, two, 0x02030405);
  assert.equal(toHex(ratchetBytes(one)), toHex(ratchetBytes(two)));
});

test("the ratchet follows megolm.md: R_j is rehashed from itself and resets the later parts", () => {
  const r = ratchetFromBytes(p.randomBytes(128), 0xff);
  const before = r.parts.map((x) => x.slice());
  advance(p, r);
  // 0xff → 0x100: R_2 changes (period 2^8), R_3 is rederived from the old R_2.
  const H = (a: Uint8Array, k: number) => p.hmacSha256(a, Uint8Array.of(k));
  assert.deepEqual(r.parts[0], before[0]);
  assert.deepEqual(r.parts[1], before[1]);
  assert.deepEqual(r.parts[2], H(before[2], 2));
  assert.deepEqual(r.parts[3], H(before[2], 3));
  advance(p, r);
  assert.deepEqual(r.parts[3], H(H(before[2], 3), 3), "a plain step rehashes only R_3");
});

test("encrypt and decrypt: in order, out of order, repeatedly", () => {
  const out = protocol.newOutboundGroupSession();
  const inbound = protocol.inboundGroupSessionFromSessionKey(out.sessionKey());
  assert.equal(inbound.sessionId(), out.sessionId());
  assert.equal(inbound.firstKnownIndex(), 0);
  assert.ok(inbound.isSigningKeyVerified());
  const messages = Array.from({ length: 30 }, (_, i) => out.encrypt(bytes(`message ${i}`)));
  assert.equal(out.messageIndex(), 30);
  for (const i of [29, 0, 15, 3, 3, 28]) {
    const r = inbound.decrypt(messages[i]);
    assert.equal(r.messageIndex, i);
    assert.equal(text(r.plaintext), `message ${i}`);
  }
});

test("a session key shared later only reads from its index on", () => {
  const out = protocol.newOutboundGroupSession();
  const early = out.encrypt(bytes("before"));
  const late = protocol.inboundGroupSessionFromSessionKey(out.sessionKey());
  assert.equal(late.firstKnownIndex(), 1);
  assert.equal(
    code(() => late.decrypt(early)),
    "UNKNOWN_MESSAGE_INDEX",
  );
  assert.equal(text(late.decrypt(out.encrypt(bytes("after"))).plaintext), "after");
});

test("forged and tampered messages are refused before decryption", () => {
  const out = protocol.newOutboundGroupSession();
  const inbound = protocol.inboundGroupSessionFromSessionKey(out.sessionKey());
  const msg = decodeBase64(out.encrypt(bytes("genuine")));
  const mutate = (f: (b: Uint8Array) => void) => {
    const c = msg.slice();
    f(c);
    return encodeBase64(c);
  };
  // Any change is caught by the signature (it covers ciphertext and MAC).
  assert.equal(
    code(() => inbound.decrypt(mutate((b) => (b[10] ^= 1)))),
    "BAD_SIGNATURE",
  );
  assert.equal(
    code(() => inbound.decrypt(mutate((b) => (b[b.length - 70] ^= 1)))),
    "BAD_SIGNATURE",
  );
  assert.equal(
    code(() => inbound.decrypt(mutate((b) => (b[b.length - 1] ^= 1)))),
    "BAD_SIGNATURE",
  );
  // A message from another session, re-signed by its own key: wrong signer.
  const other = protocol.newOutboundGroupSession();
  assert.equal(
    code(() => inbound.decrypt(other.encrypt(bytes("forged")))),
    "BAD_SIGNATURE",
  );
  // Wrong version, truncation.
  assert.equal(
    code(() => inbound.decrypt(mutate((b) => (b[0] = 2)))),
    "BAD_MESSAGE_VERSION",
  );
  assert.equal(
    code(() => inbound.decrypt(encodeBase64(msg.subarray(0, 60)))),
    "BAD_MESSAGE_FORMAT",
  );
  assert.equal(
    code(() => inbound.decrypt("%%%")),
    "BAD_MESSAGE_FORMAT",
  );
  assert.equal(text(inbound.decrypt(encodeBase64(msg)).plaintext), "genuine");
});

test("the MAC is checked on its own: a validly signed message with a wrong MAC is refused", () => {
  // Only the holder of the signing key can make this message; the MAC must still be verified.
  const out = protocol.newOutboundGroupSession();
  const inbound = protocol.inboundGroupSessionFromSessionKey(out.sessionKey());
  const signing = decodeBase64(JSON.parse(out.pickle()).signing_secret_key);
  const msg = decodeBase64(out.encrypt(bytes("mac")));
  const body = msg.slice(0, msg.length - 64);
  body[body.length - 1] ^= 1;
  const resigned = encodeBase64(concatBytes(body, p.ed25519Sign(signing, body)));
  assert.equal(
    code(() => inbound.decrypt(resigned)),
    "BAD_MESSAGE_MAC",
  );
});

test("session keys: the signature must verify; exports are unverified and start where exported", () => {
  const out = protocol.newOutboundGroupSession();
  const key = decodeBase64(out.sessionKey());
  assert.equal(key.length, 229);
  const forged = key.slice();
  forged[10] ^= 1;
  assert.equal(
    code(() => protocol.inboundGroupSessionFromSessionKey(encodeBase64(forged))),
    "BAD_SIGNATURE",
  );
  assert.equal(
    code(() => protocol.inboundGroupSessionFromSessionKey(encodeBase64(key.subarray(0, 165)))),
    "BAD_SESSION_KEY",
  );
  assert.equal(
    code(() => protocol.inboundGroupSessionFromSessionKey("&&")),
    "BAD_SESSION_KEY",
  );

  const inbound = protocol.inboundGroupSessionFromSessionKey(out.sessionKey());
  const m = [0, 1, 2, 3].map((i) => out.encrypt(bytes(`${i}`)));
  const exported = inbound.exportAt(2)!;
  assert.equal(decodeBase64(exported).length, 165);
  const imported = protocol.inboundGroupSessionFromExport(exported);
  assert.ok(!imported.isSigningKeyVerified());
  assert.equal(imported.firstKnownIndex(), 2);
  assert.equal(
    code(() => imported.decrypt(m[1])),
    "UNKNOWN_MESSAGE_INDEX",
  );
  assert.equal(text(imported.decrypt(m[3]).plaintext), "3");
  assert.equal(
    code(() => protocol.inboundGroupSessionFromExport(out.sessionKey())),
    "BAD_SESSION_KEY",
  );

  assert.equal(inbound.compare(imported), "better");
  assert.equal(imported.compare(inbound), "worse");
  assert.equal(inbound.compare(protocol.inboundGroupSessionFromSessionKey(protocol.newOutboundGroupSession().sessionKey())), "unconnected");
  // Same session ID, different ratchet (a forged export): not connected.
  const raw = decodeBase64(exported);
  raw[10] ^= 1;
  assert.equal(inbound.compare(protocol.inboundGroupSessionFromExport(encodeBase64(raw))), "unconnected");
});

test("pickles round-trip; a corrupted ratchet in the store is detected", () => {
  const out = protocol.newOutboundGroupSession();
  const inbound = protocol.inboundGroupSessionFromSessionKey(out.sessionKey());
  const m0 = out.encrypt(bytes("zero"));
  inbound.decrypt(out.encrypt(bytes("one")));
  const key = p.randomBytes(32);
  const out2 = protocol.outboundGroupSessionFromPickle(out.pickle(key), key);
  const in2 = protocol.inboundGroupSessionFromPickle(inbound.pickle());
  assert.equal(text(in2.decrypt(out2.encrypt(bytes("two"))).plaintext), "two");
  assert.equal(text(in2.decrypt(m0).plaintext), "zero");

  const state = JSON.parse(inbound.pickle());
  const latest = decodeBase64(state.latest);
  latest[0] ^= 1;
  state.latest = encodeBase64(latest);
  assert.equal(
    code(() => protocol.inboundGroupSessionFromPickle(JSON.stringify(state))),
    "BAD_PICKLE",
  );
  assert.equal(
    code(() =>
      protocol.inboundGroupSessionFromPickle(JSON.stringify({ ...JSON.parse(inbound.pickle()), latest_counter: 0, initial_counter: 5 })),
    ),
    "BAD_PICKLE",
  );
  assert.equal(
    code(() => protocol.outboundGroupSessionFromPickle(inbound.pickle())),
    "BAD_PICKLE",
  );
});
