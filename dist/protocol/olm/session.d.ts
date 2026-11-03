import type { CryptoPrimitives } from "../../crypto/primitives.ts";
import { type OlmMessage, type OlmSession, type PickleKey } from "../protocol.ts";
import { type RatchetState } from "./ratchet.ts";
/**
 * One Olm session. "Alice" is the side that created it (outbound) and "Bob" the side that
 * received its first pre-key message (inbound); both store Alice's identity and base key and
 * Bob's one-time key, which identify the session and go into every pre-key message.
 */
export interface SessionKeys {
    aliceIdentityKey: Uint8Array;
    aliceBaseKey: Uint8Array;
    bobOneTimeKey: Uint8Array;
}
export declare class NativeOlmSession implements OlmSession {
    private readonly p;
    private readonly keys;
    private ratchet;
    private receivedMessage;
    constructor(p: CryptoPrimitives, keys: SessionKeys, ratchet: RatchetState, receivedMessage: boolean);
    /** As libolm and vodozemac: SHA-256(Alice's identity key ‖ Alice's base key ‖ Bob's one-time key). */
    sessionId(): string;
    hasReceivedMessage(): boolean;
    encrypt(plaintext: Uint8Array): OlmMessage;
    decrypt(message: OlmMessage): Uint8Array;
    sessionMatches(message: OlmMessage): boolean;
    private matchesPreKey;
    pickle(key?: PickleKey): string;
    static fromPickle(p: CryptoPrimitives, pickle: string, key?: PickleKey): NativeOlmSession;
}
export declare function decodeBody(message: OlmMessage): Uint8Array;
