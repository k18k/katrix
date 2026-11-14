import { CryptoPrimitives } from "../crypto/primitives.js";
import { EncryptedFile } from "../shared/events.js";
/**
 * Attachments in encrypted rooms (https://spec.matrix.org/v1.19/client-server-api/#sending-encrypted-attachments):
 * the file is encrypted with AES-256-CTR under a fresh key, the ciphertext is uploaded, and the
 * key, IV and the ciphertext's SHA-256 travel in the (Megolm-encrypted) event as an EncryptedFile.
 */
export declare class AttachmentError extends Error {
  readonly code: "BAD_FILE_INFO" | "HASH_MISMATCH";
  constructor(code: AttachmentError["code"], message: string);
}
/** Encrypt a file. The returned `file` lacks only `url`: the mxc:// URI the ciphertext is uploaded to. */
export declare function encryptAttachment(primitives: CryptoPrimitives, plaintext: Uint8Array): {
  ciphertext: Uint8Array;
  file: Omit<EncryptedFile, "url">;
};
/**
 * Decrypt a downloaded attachment. The SHA-256 of the ciphertext is checked first, so a file
 * swapped on the server is rejected instead of being decrypted into garbage.
 */
export declare function decryptAttachment(primitives: CryptoPrimitives, ciphertext: Uint8Array, file: EncryptedFile): Uint8Array<ArrayBufferLike>;
//# sourceMappingURL=attachments.d.ts.map