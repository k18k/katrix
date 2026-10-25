import type { CryptoPrimitives, KeyPair } from "../../crypto/primitives.ts";
import { bytesEqual, concatBytes, encodeBase64, encodeUtf8, writeUint32BE } from "@katrix/shared";
import { b64, decodeKey, field, readPickle, writePickle, type Pickled } from "../pickle.ts";
import { ProtocolError, type IdentityKeys, type OlmAccount, type OlmMessage, type OlmSession, type PickleKey } from "../protocol.ts";
import { decodeNormal, decodePreKey } from "./message.ts";
import { ecdh, initialiseAsAlice, initialiseAsBob } from "./ratchet.ts";
import { decodeBody, NativeOlmSession } from "./session.ts";

/**
 * An Olm account: the device's identity keys (Curve25519 for Olm, Ed25519 for signatures), its
 * one-time keys and its fallback key.
 *
 * One-time keys: at most 100 are kept, the oldest dropped first; of those, 50 (half, as in libolm
 * and vodozemac) may be published at a time, so a key the server still hands out is still here.
 * Fallback keys: the current one and the one before it are kept, as a pre-key message for the
 * previous key may still be in flight when a new one is published.
 */

export const MAX_ONE_TIME_KEYS = 100;

interface OneTimeKey {
  id: number;
  key: KeyPair;
  published: boolean;
}

/** libolm's key ID format: the 32-bit counter, big-endian, unpadded Base64 ("AAAAAQ"). */
function keyIdString(id: number): string {
  const b = new Uint8Array(4);
  writeUint32BE(id, b, 0);
  return encodeBase64(b);
}

export class NativeOlmAccount implements OlmAccount {
  private readonly p: CryptoPrimitives;
  private curve25519: KeyPair;
  private ed25519: KeyPair;
  private oneTime: OneTimeKey[];
  private nextKeyId: number;
  private fallback?: OneTimeKey;
  private previousFallback?: OneTimeKey;

  private constructor(
    p: CryptoPrimitives,
    s: {
      curve25519: KeyPair;
      ed25519: KeyPair;
      oneTime: OneTimeKey[];
      nextKeyId: number;
      fallback?: OneTimeKey;
      previousFallback?: OneTimeKey;
    },
  ) {
    this.p = p;
    this.curve25519 = s.curve25519;
    this.ed25519 = s.ed25519;
    this.oneTime = s.oneTime;
    this.nextKeyId = s.nextKeyId;
    this.fallback = s.fallback;
    this.previousFallback = s.previousFallback;
  }

  static create(p: CryptoPrimitives): NativeOlmAccount {
    return new NativeOlmAccount(p, {
      curve25519: p.x25519GenerateKeyPair(),
      ed25519: p.ed25519GenerateKeyPair(),
      oneTime: [],
      nextKeyId: 1,
    });
  }

  identityKeys(): IdentityKeys {
    return { curve25519: encodeBase64(this.curve25519.publicKey), ed25519: encodeBase64(this.ed25519.publicKey) };
  }

  sign(message: string): string {
    return encodeBase64(this.p.ed25519Sign(this.ed25519.secretKey, encodeUtf8(message)));
  }

  maxNumberOfOneTimeKeys(): number {
    return MAX_ONE_TIME_KEYS / 2;
  }

  generateOneTimeKeys(count: number): void {
    for (let i = 0; i < count; i++) this.oneTime.push({ id: this.nextKeyId++, key: this.p.x25519GenerateKeyPair(), published: false });
    if (this.oneTime.length > MAX_ONE_TIME_KEYS) this.oneTime.splice(0, this.oneTime.length - MAX_ONE_TIME_KEYS);
  }

  oneTimeKeys(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of this.oneTime) if (!k.published) out[keyIdString(k.id)] = encodeBase64(k.key.publicKey);
    return out;
  }

  generateFallbackKey(): void {
    this.previousFallback = this.fallback;
    this.fallback = { id: this.nextKeyId++, key: this.p.x25519GenerateKeyPair(), published: false };
  }

  fallbackKey(): Record<string, string> {
    return this.fallback && !this.fallback.published ? { [keyIdString(this.fallback.id)]: encodeBase64(this.fallback.key.publicKey) } : {};
  }

  forgetFallbackKey(): boolean {
    const had = this.previousFallback !== undefined;
    this.previousFallback = undefined;
    return had;
  }

  markKeysAsPublished(): void {
    for (const k of this.oneTime) k.published = true;
    if (this.fallback) this.fallback.published = true;
  }

  createOutboundSession(identityKey: string, oneTimeKey: string): OlmSession {
    const theirIdentity = decodeKey(identityKey, 32);
    const theirOneTime = decodeKey(oneTimeKey, 32);
    const base = this.p.x25519GenerateKeyPair();
    const ratchet = this.p.x25519GenerateKeyPair();
    // S = ECDH(I_A, E_B) ‖ ECDH(E_A, I_B) ‖ ECDH(E_A, E_B)
    const secret = concatBytes(
      ecdh(this.p, this.curve25519.secretKey, theirOneTime),
      ecdh(this.p, base.secretKey, theirIdentity),
      ecdh(this.p, base.secretKey, theirOneTime),
    );
    return new NativeOlmSession(
      this.p,
      { aliceIdentityKey: this.curve25519.publicKey, aliceBaseKey: base.publicKey, bobOneTimeKey: theirOneTime },
      initialiseAsAlice(this.p, secret, ratchet),
      false,
    );
  }

  createInboundSession(theirIdentityKey: string, message: OlmMessage): { session: OlmSession; plaintext: Uint8Array } {
    if (message.type !== 0) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Only a pre-key message can start a session");
    const theirIdentity = decodeKey(theirIdentityKey, 32);
    const preKey = decodePreKey(decodeBody(message));
    if (preKey.identityKey && !bytesEqual(preKey.identityKey, theirIdentity)) {
      throw new ProtocolError("SESSION_MISMATCH", "Pre-key message is from another identity key");
    }
    const otk = this.findKey(preKey.oneTimeKey);
    if (!otk) throw new ProtocolError("UNKNOWN_ONE_TIME_KEY", "Pre-key message uses an unknown one-time key");
    const inner = decodeNormal(preKey.message);
    // Bob's side of the triple DH: ECDH(E_B, I_A) ‖ ECDH(I_B, E_A) ‖ ECDH(E_B, E_A)
    const secret = concatBytes(
      ecdh(this.p, otk.key.secretKey, theirIdentity),
      ecdh(this.p, this.curve25519.secretKey, preKey.baseKey),
      ecdh(this.p, otk.key.secretKey, preKey.baseKey),
    );
    const session = new NativeOlmSession(
      this.p,
      { aliceIdentityKey: theirIdentity, aliceBaseKey: preKey.baseKey, bobOneTimeKey: otk.key.publicKey },
      initialiseAsBob(this.p, secret, inner.ratchetKey),
      false,
    );
    // Throws (and leaves the account as it was) unless the message really is for this key.
    const plaintext = session.decrypt(message);
    if (otk !== this.fallback && otk !== this.previousFallback) this.oneTime = this.oneTime.filter((k) => k !== otk);
    return { session, plaintext };
  }

  private findKey(publicKey: Uint8Array): OneTimeKey | undefined {
    return (
      this.oneTime.find((k) => bytesEqual(k.key.publicKey, publicKey)) ??
      [this.fallback, this.previousFallback].find((k) => k !== undefined && bytesEqual(k.key.publicKey, publicKey))
    );
  }

  pickle(key?: PickleKey): string {
    const keyJson = (k: OneTimeKey) => ({
      id: k.id,
      secret_key: b64(k.key.secretKey),
      public_key: b64(k.key.publicKey),
      published: k.published,
    });
    return writePickle(
      this.p,
      "olm_account",
      {
        curve25519: { secret_key: b64(this.curve25519.secretKey), public_key: b64(this.curve25519.publicKey) },
        ed25519: { secret_key: b64(this.ed25519.secretKey), public_key: b64(this.ed25519.publicKey) },
        one_time_keys: this.oneTime.map(keyJson),
        next_key_id: this.nextKeyId,
        fallback: this.fallback ? keyJson(this.fallback) : null,
        previous_fallback: this.previousFallback ? keyJson(this.previousFallback) : null,
      },
      key,
    );
  }

  static fromPickle(p: CryptoPrimitives, pickle: string, key?: PickleKey): NativeOlmAccount {
    const s = readPickle(p, "olm_account", pickle, key);
    const pair = (j: Pickled | undefined): KeyPair => {
      if (!j) throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
      return { secretKey: field.bytes(j, "secret_key", 32), publicKey: field.bytes(j, "public_key", 32) };
    };
    const otk = (j: Pickled): OneTimeKey => ({ id: field.uint(j, "id"), key: pair(j), published: field.bool(j, "published") });
    const fallback = field.optional(s, "fallback");
    const previous = field.optional(s, "previous_fallback");
    const account = new NativeOlmAccount(p, {
      curve25519: pair(field.optional(s, "curve25519")),
      ed25519: pair(field.optional(s, "ed25519")),
      oneTime: field.array(s, "one_time_keys").map(otk),
      nextKeyId: field.uint(s, "next_key_id"),
      fallback: fallback ? otk(fallback) : undefined,
      previousFallback: previous ? otk(previous) : undefined,
    });
    // A pickle whose public keys do not belong to its secret keys is corrupted, not usable.
    if (
      !bytesEqual(p.x25519PublicKey(account.curve25519.secretKey), account.curve25519.publicKey) ||
      !bytesEqual(p.ed25519PublicKey(account.ed25519.secretKey), account.ed25519.publicKey)
    ) {
      throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
    }
    return account;
  }
}
