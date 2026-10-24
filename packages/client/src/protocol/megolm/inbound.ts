import type { CryptoPrimitives } from "../../crypto/primitives.ts";
import { decodeBase64, encodeBase64 } from "../../util/base64.ts";
import { bytesEqual, constantTimeEqual } from "../../util/bytes.ts";
import { b64, field, readPickle, writePickle } from "../pickle.ts";
import { ProtocolError, type InboundGroupSession, type PickleKey, type SessionOrdering } from "../protocol.ts";
import { decodeMessage } from "./message.ts";
import { advanceTo, copyRatchet, messageKeys, ratchetBytes, ratchetFromBytes, type MegolmRatchet } from "./ratchet.ts";
import { decodeExport, decodeSessionKey, encodeExport } from "./session-key.ts";

/**
 * An inbound Megolm session. It keeps the ratchet at the first known index (to decrypt any later
 * message, in any order) and the latest one it reached (so decrypting in order costs one step).
 */
export class NativeInboundGroupSession implements InboundGroupSession {
  private readonly p: CryptoPrimitives;
  private readonly initial: MegolmRatchet;
  private latest: MegolmRatchet;
  private readonly signingKey: Uint8Array;
  private readonly signingKeyVerified: boolean;

  private constructor(p: CryptoPrimitives, initial: MegolmRatchet, latest: MegolmRatchet, signingKey: Uint8Array, verified: boolean) {
    this.p = p;
    this.initial = initial;
    this.latest = latest;
    this.signingKey = signingKey;
    this.signingKeyVerified = verified;
  }

  static fromSessionKey(p: CryptoPrimitives, sessionKey: string): NativeInboundGroupSession {
    const { ratchet, signingKey } = decodeSessionKey(p, sessionKey);
    return new NativeInboundGroupSession(p, ratchet, copyRatchet(ratchet), signingKey, true);
  }

  static fromExport(p: CryptoPrimitives, exported: string): NativeInboundGroupSession {
    const { ratchet, signingKey } = decodeExport(exported);
    return new NativeInboundGroupSession(p, ratchet, copyRatchet(ratchet), signingKey, false);
  }

  sessionId(): string {
    return encodeBase64(this.signingKey);
  }

  firstKnownIndex(): number {
    return this.initial.counter;
  }

  isSigningKeyVerified(): boolean {
    return this.signingKeyVerified;
  }

  /** The ratchet at `index`, from the closest known state at or before it. */
  private ratchetAt(index: number): MegolmRatchet | undefined {
    if (index < this.initial.counter) return undefined;
    const r = copyRatchet(this.latest.counter <= index ? this.latest : this.initial);
    advanceTo(this.p, r, index);
    return r;
  }

  decrypt(ciphertext: string): { plaintext: Uint8Array; messageIndex: number } {
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(ciphertext);
    } catch {
      throw new ProtocolError("BAD_MESSAGE_FORMAT", "Ciphertext is not Base64");
    }
    const m = decodeMessage(bytes);
    // The signature first: it binds the message to the session's key, so a message is rejected
    // before anything is computed from the ratchet for it.
    if (!this.p.ed25519Verify(this.signingKey, m.signatureInput, m.signature)) {
      throw new ProtocolError("BAD_SIGNATURE", "Megolm message signature does not verify");
    }
    const r = this.ratchetAt(m.index);
    if (!r) throw new ProtocolError("UNKNOWN_MESSAGE_INDEX", "The session does not know this message index");
    const keys = messageKeys(this.p, r);
    if (!constantTimeEqual(this.p.hmacSha256(keys.mac, m.macInput).subarray(0, m.mac.length), m.mac)) {
      throw new ProtocolError("BAD_MESSAGE_MAC", "Megolm message MAC does not match");
    }
    let plaintext: Uint8Array;
    try {
      plaintext = this.p.aes256CbcDecrypt(keys.aes, keys.iv, m.ciphertext);
    } catch {
      throw new ProtocolError("BAD_DECRYPTION", "Megolm message does not decrypt");
    }
    if (r.counter > this.latest.counter) this.latest = r;
    return { plaintext, messageIndex: m.index };
  }

  exportAt(index: number): string | undefined {
    const r = this.ratchetAt(index);
    return r ? encodeExport(r, this.signingKey) : undefined;
  }

  compare(other: InboundGroupSession): SessionOrdering {
    if (other.sessionId() !== this.sessionId()) return "unconnected";
    const theirIndex = other.firstKnownIndex();
    const mine = this.initial.counter;
    // Connected only if both ratchets agree at the later of the two first indices.
    const at = Math.max(mine, theirIndex);
    const a = this.exportAt(at);
    const b = other.exportAt(at);
    if (!a || !b || a !== b) return "unconnected";
    return mine < theirIndex ? "better" : mine === theirIndex ? "equal" : "worse";
  }

  pickle(key?: PickleKey): string {
    return writePickle(
      this.p,
      "megolm_inbound",
      {
        initial: b64(ratchetBytes(this.initial)),
        initial_counter: this.initial.counter,
        latest: b64(ratchetBytes(this.latest)),
        latest_counter: this.latest.counter,
        signing_key: b64(this.signingKey),
        signing_key_verified: this.signingKeyVerified,
      },
      key,
    );
  }

  static fromPickle(p: CryptoPrimitives, pickle: string, key?: PickleKey): NativeInboundGroupSession {
    const s = readPickle(p, "megolm_inbound", pickle, key);
    const initial = ratchetFromBytes(field.bytes(s, "initial", 128), field.uint(s, "initial_counter"));
    const latest = ratchetFromBytes(field.bytes(s, "latest", 128), field.uint(s, "latest_counter"));
    if (latest.counter < initial.counter) throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
    const signingKey = field.bytes(s, "signing_key", 32);
    // A latest ratchet that does not follow from the initial one would decrypt nothing, or worse,
    // something else: check it rather than trust the store.
    const check = copyRatchet(initial);
    advanceTo(p, check, latest.counter);
    if (!bytesEqual(ratchetBytes(check), ratchetBytes(latest))) throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
    return new NativeInboundGroupSession(p, initial, latest, signingKey, field.bool(s, "signing_key_verified"));
  }
}
