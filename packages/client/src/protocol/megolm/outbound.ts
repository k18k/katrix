import type { CryptoPrimitives, KeyPair } from "../../crypto/primitives.ts";
import { concatBytes, encodeBase64 } from "@katrix/shared";
import { b64, field, readPickle, writePickle } from "../pickle.ts";
import type { OutboundGroupSession, PickleKey } from "../protocol.ts";
import { encodeBody, MAC_LENGTH } from "./message.ts";
import { advance, messageKeys, ratchetBytes, ratchetFromBytes, type MegolmRatchet } from "./ratchet.ts";
import { encodeSessionKey } from "./session-key.ts";

export class NativeOutboundGroupSession implements OutboundGroupSession {
  private readonly p: CryptoPrimitives;
  private ratchet: MegolmRatchet;
  private readonly signing: KeyPair;

  private constructor(p: CryptoPrimitives, ratchet: MegolmRatchet, signing: KeyPair) {
    this.p = p;
    this.ratchet = ratchet;
    this.signing = signing;
  }

  /** A fresh session: random ratchet at index 0 and a new Ed25519 key, whose public half is the ID. */
  static create(p: CryptoPrimitives): NativeOutboundGroupSession {
    return new NativeOutboundGroupSession(p, ratchetFromBytes(p.randomBytes(128), 0), p.ed25519GenerateKeyPair());
  }

  sessionId(): string {
    return encodeBase64(this.signing.publicKey);
  }

  messageIndex(): number {
    return this.ratchet.counter;
  }

  sessionKey(): string {
    return encodeSessionKey(this.p, this.ratchet, this.signing);
  }

  encrypt(plaintext: Uint8Array): string {
    const keys = messageKeys(this.p, this.ratchet);
    const ciphertext = this.p.aes256CbcEncrypt(keys.aes, keys.iv, plaintext);
    const body = encodeBody(this.ratchet.counter, ciphertext);
    const authenticated = concatBytes(body, this.p.hmacSha256(keys.mac, body).subarray(0, MAC_LENGTH));
    const signature = this.p.ed25519Sign(this.signing.secretKey, authenticated);
    advance(this.p, this.ratchet);
    return encodeBase64(concatBytes(authenticated, signature));
  }

  pickle(key?: PickleKey): string {
    return writePickle(
      this.p,
      "megolm_outbound",
      {
        ratchet: b64(ratchetBytes(this.ratchet)),
        counter: this.ratchet.counter,
        signing_secret_key: b64(this.signing.secretKey),
        signing_public_key: b64(this.signing.publicKey),
      },
      key,
    );
  }

  static fromPickle(p: CryptoPrimitives, pickle: string, key?: PickleKey): NativeOutboundGroupSession {
    const s = readPickle(p, "megolm_outbound", pickle, key);
    return new NativeOutboundGroupSession(p, ratchetFromBytes(field.bytes(s, "ratchet", 128), field.uint(s, "counter")), {
      secretKey: field.bytes(s, "signing_secret_key", 32),
      publicKey: field.bytes(s, "signing_public_key", 32),
    });
  }
}
