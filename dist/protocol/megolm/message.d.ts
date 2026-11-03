/**
 * The Megolm message (megolm.md, "Message format"):
 *
 *   0x03 | 0x08 message index | 0x12 ciphertext | MAC (8 bytes) | Ed25519 signature (64 bytes)
 *
 * The MAC covers everything before it; the signature covers everything before it, MAC included.
 */
export declare const VERSION = 3;
export declare const MAC_LENGTH = 8;
export declare const SIGNATURE_LENGTH = 64;
export declare function encodeBody(index: number, ciphertext: Uint8Array): Uint8Array;
export interface DecodedMegolmMessage {
    index: number;
    ciphertext: Uint8Array;
    /** Bytes covered by the MAC. */
    macInput: Uint8Array;
    mac: Uint8Array;
    /** Bytes covered by the signature. */
    signatureInput: Uint8Array;
    signature: Uint8Array;
}
export declare function decodeMessage(bytes: Uint8Array): DecodedMegolmMessage;
