import type { CryptoPrimitives, KeyPair } from "../../crypto/primitives.ts";
import { type Pickled } from "../pickle.ts";
export declare const MAX_RECEIVER_CHAINS = 5;
export declare const MAX_SKIPPED_MESSAGE_KEYS = 40;
export declare const MAX_MESSAGE_GAP = 2000;
interface ChainKey {
    key: Uint8Array;
    index: number;
}
interface SenderChain {
    ratchet: KeyPair;
    chainKey: ChainKey;
}
interface ReceiverChain {
    ratchetKey: Uint8Array;
    chainKey: ChainKey;
}
interface SkippedKey {
    ratchetKey: Uint8Array;
    index: number;
    messageKey: Uint8Array;
}
export interface RatchetState {
    rootKey: Uint8Array;
    senderChain?: SenderChain;
    /** Newest first. */
    receiverChains: ReceiverChain[];
    /** Oldest first. */
    skipped: SkippedKey[];
}
/**
 * ECDH with a key from the wire. A low-order key (which X25519 refuses) is the sender's fault:
 * a ProtocolError like any other bad message, so callers treat it as one undecryptable message
 * and not as an internal failure.
 */
export declare function ecdh(p: CryptoPrimitives, secretKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array;
export declare function initialiseAsAlice(p: CryptoPrimitives, sharedSecret: Uint8Array, ratchet: KeyPair): RatchetState;
export declare function initialiseAsBob(p: CryptoPrimitives, sharedSecret: Uint8Array, theirRatchetKey: Uint8Array): RatchetState;
/** Encrypts and returns the encoded normal message (with MAC). Mutates `state`. */
export declare function ratchetEncrypt(p: CryptoPrimitives, state: RatchetState, plaintext: Uint8Array): Uint8Array;
/**
 * Decrypts an encoded normal message. Works on a copy of the state and returns the new state
 * with the plaintext: a message that fails (wrong MAC, replayed, too far ahead) changes nothing.
 */
export declare function ratchetDecrypt(p: CryptoPrimitives, current: RatchetState, bytes: Uint8Array): {
    state: RatchetState;
    plaintext: Uint8Array;
};
export declare function cloneRatchet(s: RatchetState): RatchetState;
export declare function ratchetToJson(s: RatchetState): Pickled;
export declare function ratchetFromJson(j: Pickled): RatchetState;
export {};
