import type { CryptoPrimitives } from "../crypto/primitives.ts";
import { Base64Error, constantTimeEqual, decodeBase64, encodeBase64, type EncryptedFile } from "@katrix/shared";

/**
 * Attachments in encrypted rooms (https://spec.matrix.org/v1.19/client-server-api/#sending-encrypted-attachments):
 * the file is encrypted with AES-256-CTR under a fresh key, the ciphertext is uploaded, and the
 * key, IV and the ciphertext's SHA-256 travel in the (Megolm-encrypted) event as an EncryptedFile.
 */

export class AttachmentError extends Error {
  readonly code: "BAD_FILE_INFO" | "HASH_MISMATCH";
  constructor(code: AttachmentError["code"], message: string) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
  }
}

/** Encrypt a file. The returned `file` lacks only `url`: the mxc:// URI the ciphertext is uploaded to. */
export function encryptAttachment(
  primitives: CryptoPrimitives,
  plaintext: Uint8Array,
): { ciphertext: Uint8Array; file: Omit<EncryptedFile, "url"> } {
  const key = primitives.randomBytes(32);
  // The spec's counter block: 64 random bits, then a 64-bit counter starting at zero, so the
  // counter cannot wrap into the random half for any file size.
  const iv = new Uint8Array(16);
  iv.set(primitives.randomBytes(8), 0);
  const ciphertext = primitives.aes256Ctr(key, iv, plaintext);
  return {
    ciphertext,
    file: {
      key: { kty: "oct", key_ops: ["encrypt", "decrypt"], alg: "A256CTR", k: encodeBase64(key, { urlSafe: true }), ext: true },
      iv: encodeBase64(iv),
      hashes: { sha256: encodeBase64(primitives.sha256(ciphertext)) },
      v: "v2",
    },
  };
}

/**
 * Decrypt a downloaded attachment. The SHA-256 of the ciphertext is checked first, so a file
 * swapped on the server is rejected instead of being decrypted into garbage.
 */
export function decryptAttachment(primitives: CryptoPrimitives, ciphertext: Uint8Array, file: EncryptedFile): Uint8Array {
  const info = file as Partial<EncryptedFile> | undefined;
  const k = info?.key;
  if (
    info?.v !== "v2" ||
    !k ||
    k.kty !== "oct" ||
    k.alg !== "A256CTR" ||
    !Array.isArray(k.key_ops) ||
    !k.key_ops.includes("decrypt") ||
    typeof k.k !== "string" ||
    typeof info.iv !== "string" ||
    typeof info.hashes?.sha256 !== "string"
  )
    throw new AttachmentError("BAD_FILE_INFO", "Unsupported encrypted file information");
  let key: Uint8Array, iv: Uint8Array, hash: Uint8Array;
  try {
    key = decodeBase64(k.k);
    iv = decodeBase64(info.iv);
    hash = decodeBase64(info.hashes.sha256);
  } catch (e) {
    if (e instanceof Base64Error) throw new AttachmentError("BAD_FILE_INFO", "Invalid base64 in encrypted file information");
    throw e;
  }
  if (key.length !== 32 || iv.length !== 16 || hash.length !== 32)
    throw new AttachmentError("BAD_FILE_INFO", "Invalid key, IV or hash length");
  if (!constantTimeEqual(primitives.sha256(ciphertext), hash))
    throw new AttachmentError("HASH_MISMATCH", "The file does not match its hash");
  return primitives.aes256Ctr(key, iv, ciphertext);
}
