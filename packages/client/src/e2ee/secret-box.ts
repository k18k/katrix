import type { CryptoPrimitives } from "../crypto/primitives.ts";
import type { PickleKey } from "../protocol/protocol.ts";
import { concatBytes, constantTimeEqual, decodeBase64, encodeBase64, encodeUtf8 } from "@katrix/shared";

/**
 * Secrets this device keeps at rest (cross-signing private keys, the backup key), sealed with the
 * pickle key like the Olm and Megolm pickles: AES-256-CTR and HMAC-SHA-256 under keys derived
 * from it per secret name. Without a pickle key they are stored as they are, and the storage
 * adapter is the only protection, as for the pickles.
 */
export class SecretBox {
  private readonly primitives: CryptoPrimitives;
  private readonly key?: PickleKey;

  constructor(primitives: CryptoPrimitives, key?: PickleKey) {
    this.primitives = primitives;
    this.key = key;
  }

  private keys(name: string): { aes: Uint8Array; mac: Uint8Array } {
    const okm = this.primitives.hkdfSha256(this.key!, undefined, encodeUtf8(`katrix secret ${name}`), 64);
    return { aes: okm.subarray(0, 32), mac: okm.subarray(32) };
  }

  seal(name: string, secret: Uint8Array): string {
    if (!this.key) return `plain:${encodeBase64(secret)}`;
    const { aes, mac } = this.keys(name);
    const iv = this.primitives.randomBytes(16);
    const ciphertext = this.primitives.aes256Ctr(aes, iv, secret);
    const tag = this.primitives.hmacSha256(mac, concatBytes(iv, ciphertext));
    return `v1:${encodeBase64(concatBytes(iv, ciphertext, tag))}`;
  }

  /** Throws when the sealed value was made with another pickle key or was changed. */
  open(name: string, sealed: string): Uint8Array {
    if (sealed.startsWith("plain:")) {
      if (this.key) throw new Error("A secret was stored without the pickle key");
      return decodeBase64(sealed.slice("plain:".length));
    }
    if (!sealed.startsWith("v1:") || !this.key) throw new Error("A stored secret cannot be opened without its pickle key");
    const bytes = decodeBase64(sealed.slice(3));
    if (bytes.length < 48) throw new Error("A stored secret is damaged");
    const iv = bytes.subarray(0, 16);
    const ciphertext = bytes.subarray(16, bytes.length - 32);
    const { aes, mac } = this.keys(name);
    if (!constantTimeEqual(this.primitives.hmacSha256(mac, concatBytes(iv, ciphertext)), bytes.subarray(bytes.length - 32)))
      throw new Error("A stored secret does not match the pickle key");
    return this.primitives.aes256Ctr(aes, iv, ciphertext);
  }
}
