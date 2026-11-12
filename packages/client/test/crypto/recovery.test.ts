import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { BackupDecryptionKey, SecretStorageKey } from "@matrix-org/matrix-sdk-crypto-nodejs";
import { nobleCryptoPrimitives } from "../../src/crypto/noble.ts";
import { decryptBackupSession, encryptBackupSession, type BackedUpSession } from "../../src/e2ee/backup.ts";
import {
  decodeRecoveryKey,
  decryptSecret,
  encodeRecoveryKey,
  encryptSecret,
  SecretStorage,
  SecretStorageError,
} from "../../src/e2ee/secret-storage.ts";
import { decodeBase58, encodeBase58 } from "../../src/util/base58.ts";
import { decodeBase64, decodeUtf8, encodeBase64, encodeUtf8 } from "@katrix/shared";

// Secret storage, recovery keys and key backup encryption: against the spec's formats, Node.js's
// OpenSSL, and matrix-sdk-crypto (the Element apps' crypto) as an independent implementation.

const p = nobleCryptoPrimitives();

test("PBKDF2-SHA-512 matches OpenSSL", () => {
  for (const iterations of [1, 2, 1000]) {
    const password = p.randomBytes(13);
    const salt = p.randomBytes(16);
    assert.deepEqual(
      p.pbkdf2Sha512(password, salt, iterations, 32),
      new Uint8Array(nodeCrypto.pbkdf2Sync(password, salt, iterations, 32, "sha512")),
    );
  }
  assert.throws(() => p.pbkdf2Sha512(new Uint8Array(1), new Uint8Array(1), 0, 32));
});

test("base58: the Bitcoin alphabet, leading zeros kept", () => {
  assert.equal(encodeBase58(encodeUtf8("Hello World!")), "2NEpo7TZRRrLZSi2U");
  assert.equal(encodeBase58(new Uint8Array([0, 0, 1])), "112");
  for (const n of [0, 1, 5, 35]) {
    const bytes = p.randomBytes(n);
    assert.deepEqual(decodeBase58(encodeBase58(bytes)), bytes);
  }
  assert.throws(() => decodeBase58("0OIl"));
});

test("recovery keys: the spec's representation, as matrix-sdk-crypto makes them", () => {
  const key = p.randomBytes(32);
  const text = encodeRecoveryKey(key);
  assert.match(text, /^(\S{4} )+\S{1,4}$/, "groups of four");
  assert.deepEqual(decodeRecoveryKey(text), key);
  assert.deepEqual(decodeRecoveryKey(text.replace(/ /g, "")), key, "whitespace is ignored");
  const bad = text.slice(0, -1) + (text.endsWith("a") ? "b" : "a");
  assert.throws(() => decodeRecoveryKey(bad), SecretStorageError, "a typo fails the parity");
  assert.throws(() => decodeRecoveryKey("not a key"), SecretStorageError);

  const rust = SecretStorageKey.createRandomKey();
  const fromRust = decodeRecoveryKey(rust.toBase58());
  assert.equal(fromRust.length, 32);
  assert.equal(encodeRecoveryKey(fromRust).replace(/ /g, ""), rust.toBase58().replace(/ /g, ""));
});

/** An in-memory account data store. */
function accountData() {
  const data = new Map<string, Record<string, unknown>>();
  return {
    data,
    access: { get: async (t: string) => data.get(t), set: async (t: string, c: Record<string, unknown>) => void data.set(t, c) },
  };
}

test("secret storage: secrets matrix-sdk-crypto encrypts decrypt here, and the other way", async () => {
  const rust = SecretStorageKey.createRandomKey();
  const key = decodeRecoveryKey(rust.toBase58());
  const { data, access } = accountData();
  data.set(rust.eventType(), JSON.parse(rust.accountDataContent()));
  data.set("m.secret_storage.default_key", { key: rust.keyId() });
  const storage = new SecretStorage(p, access);
  assert.equal(await storage.checkKey(key), true, "the key description's check MAC");
  assert.equal(await storage.checkKey(p.randomBytes(32)), false);

  const rustSecret = JSON.parse(rust.encrypt("the secret", "m.cross_signing.master"));
  data.set("m.cross_signing.master", rustSecret);
  assert.equal(await storage.get("m.cross_signing.master", key), "the secret");

  await storage.store("m.megolm_backup.v1", "another secret", key);
  assert.equal(rust.decrypt(JSON.stringify(data.get("m.megolm_backup.v1")), "m.megolm_backup.v1"), "another secret");
  await assert.rejects(storage.store("x", "y", p.randomBytes(32)), SecretStorageError, "a wrong key is refused");
});

test("secret storage: passphrase keys derive as matrix-sdk-crypto derives them", async () => {
  const rust = SecretStorageKey.createFromPassphrase("correct horse battery staple");
  const { data, access } = accountData();
  data.set(rust.eventType(), JSON.parse(rust.accountDataContent()));
  data.set("m.secret_storage.default_key", { key: rust.keyId() });
  const storage = new SecretStorage(p, access);
  const key = await storage.keyFromPassphrase("correct horse battery staple");
  assert.equal(await storage.checkKey(key), true);
  assert.equal(await storage.checkKey(await storage.keyFromPassphrase("wrong")), false);

  // And ours, opened by matrix-sdk-crypto with the passphrase.
  const mine = accountData();
  const created = await new SecretStorage(p, mine.access).createKey({ passphrase: "pass phrase" });
  const desc = mine.data.get(`m.secret_storage.key.${created.keyId}`)!;
  const opened = SecretStorageKey.fromAccountData("pass phrase", `m.secret_storage.key.${created.keyId}`, JSON.stringify(desc));
  assert.equal(opened.keyId(), created.keyId);
  assert.deepEqual(decodeRecoveryKey(opened.toBase58()), created.key);
});

test("secret storage encryption: the IV's bit 63 is clear; tampering is detected", () => {
  const key = p.randomBytes(32);
  for (let i = 0; i < 20; i++) {
    const enc = encryptSecret(p, key, "name", encodeUtf8("x"));
    assert.equal(decodeBase64(enc.iv)[8] & 0x80, 0);
  }
  const enc = encryptSecret(p, key, "name", encodeUtf8("secret"));
  assert.equal(decodeUtf8(decryptSecret(p, key, "name", enc)), "secret");
  assert.throws(() => decryptSecret(p, key, "other name", enc), SecretStorageError, "the name is bound in");
  const ct = decodeBase64(enc.ciphertext);
  ct[0] ^= 1;
  assert.throws(() => decryptSecret(p, key, "name", { ...enc, ciphertext: encodeBase64(ct) }), SecretStorageError);
});

test("key backup: sessions encrypted here decrypt in matrix-sdk-crypto; and back here", () => {
  const rust = BackupDecryptionKey.createRandomKey();
  const publicKey = decodeBase64(rust.megolmV1PublicKey.publicKeyBase64);
  const session: BackedUpSession = {
    algorithm: "m.megolm.v1.aes-sha2",
    forwarding_curve25519_key_chain: [],
    sender_key: encodeBase64(p.randomBytes(32)),
    sender_claimed_keys: { ed25519: encodeBase64(p.randomBytes(32)) },
    session_key: encodeBase64(p.randomBytes(229)),
  };
  const data = encryptBackupSession(p, publicKey, session);
  assert.deepEqual(JSON.parse(rust.decryptV1(data.ephemeral, data.mac, data.ciphertext)), session);
  assert.deepEqual(decryptBackupSession(p, decodeBase64(rust.toBase64()), data), session);
  assert.throws(() => decryptBackupSession(p, p.randomBytes(32), data), "another key");
});
