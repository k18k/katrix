import { test } from "node:test";
import assert from "node:assert/strict";
import { nobleCryptoPrimitives } from "../../src/crypto/noble.ts";
import { decryptBackupSession, encryptBackupSession } from "../../src/e2ee/backup.ts";
import { decodeRecoveryKey, decryptSecret, encodeRecoveryKey, encryptSecret } from "../../src/e2ee/secret-storage.ts";
import { decodeQr, encodeQr } from "../../src/e2ee/verification/qr.ts";
import { sasBytes, sasEmoji, sasMac } from "../../src/e2ee/verification/sas.ts";
import { decryptAttachment, encryptAttachment } from "../../src/media/attachments.ts";
import { decodeUtf8, encodeUtf8 } from "@katrix/shared";

// Runs only under test/env/hermes.ts (npm run test:hermes): the crypto beyond Olm and Megolm,
// without TextDecoder, Buffer, WebCrypto or WebAssembly.

const p = nobleCryptoPrimitives();

test("secret storage, recovery keys and passphrases", () => {
  const key = p.randomBytes(32);
  assert.deepEqual(decodeRecoveryKey(encodeRecoveryKey(key)), key);
  const enc = encryptSecret(p, key, "m.cross_signing.master", encodeUtf8("zażółć"));
  assert.equal(decodeUtf8(decryptSecret(p, key, "m.cross_signing.master", enc)), "zażółć");
  assert.equal(p.pbkdf2Sha512(encodeUtf8("pass"), encodeUtf8("salt"), 10, 32).length, 32);
});

test("key backup encryption", () => {
  const backup = p.x25519GenerateKeyPair();
  const session = {
    algorithm: "m.megolm.v1.aes-sha2",
    forwarding_curve25519_key_chain: [],
    sender_key: "k",
    sender_claimed_keys: { ed25519: "e" },
    session_key: "s",
  };
  assert.deepEqual(decryptBackupSession(p, backup.secretKey, encryptBackupSession(p, backup.publicKey, session)), session);
});

test("SAS and QR codes", () => {
  const a = p.x25519GenerateKeyPair();
  const b = p.x25519GenerateKeyPair();
  const sharedA = p.x25519SharedSecret(a.secretKey, b.publicKey);
  const sharedB = p.x25519SharedSecret(b.secretKey, a.publicKey);
  assert.deepEqual(sasEmoji(sasBytes(p, sharedA, "info")), sasEmoji(sasBytes(p, sharedB, "info")));
  const params = { senderUser: "@a:x", senderDevice: "A", otherUser: "@b:x", otherDevice: "B", transactionId: "t", keyId: "ed25519:A" };
  assert.equal(sasMac(p, sharedA, params, "key"), sasMac(p, sharedB, params, "key"));
  const qr = {
    mode: 1 as const,
    transactionId: "txn",
    firstKey: p.randomBytes(32),
    secondKey: p.randomBytes(32),
    secret: p.randomBytes(16),
  };
  assert.deepEqual(decodeQr(encodeQr(qr)), qr);
});

test("encrypted attachments", () => {
  const data = p.randomBytes(5000);
  const { ciphertext, file } = encryptAttachment(p, data);
  assert.deepEqual(decryptAttachment(p, ciphertext, { ...file, url: "mxc://x/y" }), data);
});
