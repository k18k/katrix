import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { nobleCryptoPrimitives } from "../../src/crypto/noble.ts";
import { AttachmentError, decryptAttachment, encryptAttachment } from "../../src/media/attachments.ts";
import { decodeBase64, encodeBase64, encodeUtf8, type EncryptedFile } from "@katrix/shared";

// Encrypted attachments (https://spec.matrix.org/v1.19/client-server-api/#sending-encrypted-attachments)
// against Node.js's OpenSSL AES-256-CTR and SHA-256, then on file information they must refuse.

const p = nobleCryptoPrimitives();

function openssl(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const c = nodeCrypto.createCipheriv("aes-256-ctr", key, iv);
  return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
}

test("encryptAttachment: OpenSSL decrypts it; the file info is what the spec describes", () => {
  for (const size of [0, 1, 15, 16, 17, 4096, 100_003]) {
    const plaintext = p.randomBytes(size);
    const { ciphertext, file } = encryptAttachment(p, plaintext);
    const key = decodeBase64(file.key.k);
    const iv = decodeBase64(file.iv);
    assert.equal(key.length, 32);
    assert.deepEqual([...iv.subarray(8)], [0, 0, 0, 0, 0, 0, 0, 0], "the counter half starts at zero");
    assert.match(file.key.k, /^[A-Za-z0-9_-]+$/, "JWK keys are unpadded base64url");
    assert.deepEqual(openssl(key, iv, ciphertext), plaintext);
    assert.equal(file.hashes.sha256, nodeCrypto.createHash("sha256").update(ciphertext).digest("base64").replace(/=+$/, ""));
    assert.deepEqual(file.key, { kty: "oct", key_ops: ["encrypt", "decrypt"], alg: "A256CTR", k: file.key.k, ext: true });
    assert.equal(file.v, "v2");
  }
});

test("decryptAttachment: what OpenSSL encrypted, including a counter that wraps around 2^128", () => {
  for (const iv of [p.randomBytes(16), new Uint8Array(16).fill(0xff)]) {
    const key = p.randomBytes(32);
    const plaintext = encodeUtf8("Hello, World! ".repeat(10));
    const ciphertext = openssl(key, iv, plaintext);
    const file: EncryptedFile = {
      url: "mxc://localhost/x",
      key: { kty: "oct", key_ops: ["encrypt", "decrypt"], alg: "A256CTR", k: encodeBase64(key, { urlSafe: true }), ext: true },
      iv: encodeBase64(iv),
      hashes: { sha256: nodeCrypto.createHash("sha256").update(ciphertext).digest("base64") },
      v: "v2",
    };
    assert.deepEqual(decryptAttachment(p, ciphertext, file), plaintext);
  }
});

test("decryptAttachment refuses a tampered file and unsupported file information", () => {
  const { ciphertext, file } = encryptAttachment(p, encodeUtf8("secret"));
  const full = { ...file, url: "mxc://localhost/x" } as EncryptedFile;
  const tampered = ciphertext.slice();
  tampered[0] ^= 1;
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      assert.ok(e instanceof AttachmentError);
      assert.ok(!e.message.includes(file.key.k), "the key is not in the error");
      return e.code;
    }
    return "none";
  };
  assert.equal(
    code(() => decryptAttachment(p, tampered, full)),
    "HASH_MISMATCH",
  );
  assert.equal(
    code(() => decryptAttachment(p, ciphertext, { ...full, v: "v1" as "v2" })),
    "BAD_FILE_INFO",
  );
  assert.equal(
    code(() => decryptAttachment(p, ciphertext, { ...full, key: { ...full.key, alg: "A128CTR" as "A256CTR" } })),
    "BAD_FILE_INFO",
  );
  assert.equal(
    code(() => decryptAttachment(p, ciphertext, { ...full, key: { ...full.key, key_ops: ["encrypt"] } })),
    "BAD_FILE_INFO",
  );
  assert.equal(
    code(() => decryptAttachment(p, ciphertext, { ...full, iv: "AAAA" })),
    "BAD_FILE_INFO",
  );
  assert.equal(
    code(() => decryptAttachment(p, ciphertext, { ...full, iv: "!!" })),
    "BAD_FILE_INFO",
  );
  assert.equal(
    code(() => decryptAttachment(p, ciphertext, undefined as never)),
    "BAD_FILE_INFO",
  );
});
