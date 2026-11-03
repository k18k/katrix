import type { CryptoPrimitives } from "../../crypto/primitives.ts";
import { type InboundGroupSession, type PickleKey, type SessionOrdering } from "../protocol.ts";
/**
 * An inbound Megolm session. It keeps the ratchet at the first known index (to decrypt any later
 * message, in any order) and the latest one it reached (so decrypting in order costs one step).
 */
export declare class NativeInboundGroupSession implements InboundGroupSession {
    private readonly p;
    private readonly initial;
    private latest;
    private readonly signingKey;
    private readonly signingKeyVerified;
    private constructor();
    static fromSessionKey(p: CryptoPrimitives, sessionKey: string): NativeInboundGroupSession;
    static fromExport(p: CryptoPrimitives, exported: string): NativeInboundGroupSession;
    sessionId(): string;
    firstKnownIndex(): number;
    isSigningKeyVerified(): boolean;
    /** The ratchet at `index`, from the closest known state at or before it. */
    private ratchetAt;
    decrypt(ciphertext: string): {
        plaintext: Uint8Array;
        messageIndex: number;
    };
    exportAt(index: number): string | undefined;
    compare(other: InboundGroupSession): SessionOrdering;
    pickle(key?: PickleKey): string;
    static fromPickle(p: CryptoPrimitives, pickle: string, key?: PickleKey): NativeInboundGroupSession;
}
