import type { CryptoPrimitives } from "../../crypto/primitives.ts";
import type { OutboundGroupSession, PickleKey } from "../protocol.ts";
export declare class NativeOutboundGroupSession implements OutboundGroupSession {
    private readonly p;
    private ratchet;
    private readonly signing;
    private constructor();
    /** A fresh session: random ratchet at index 0 and a new Ed25519 key, whose public half is the ID. */
    static create(p: CryptoPrimitives): NativeOutboundGroupSession;
    sessionId(): string;
    messageIndex(): number;
    sessionKey(): string;
    encrypt(plaintext: Uint8Array): string;
    pickle(key?: PickleKey): string;
    static fromPickle(p: CryptoPrimitives, pickle: string, key?: PickleKey): NativeOutboundGroupSession;
}
