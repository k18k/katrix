/**
 * Olm message formats (olm.md, "The Olm Message Format"). Keys are raw 32-byte Curve25519 keys.
 *
 *   normal:  0x03 | 0x0A ratchet key | 0x10 chain index | 0x22 ciphertext | MAC (8 bytes)
 *   pre-key: 0x03 | 0x0A one-time key | 0x12 base key | 0x1A identity key | 0x22 normal message
 */
export declare const VERSION = 3;
export declare const MAC_LENGTH = 8;
export interface NormalMessage {
    ratchetKey: Uint8Array;
    chainIndex: number;
    ciphertext: Uint8Array;
    /** The bytes the MAC covers (everything before it). */
    authenticated: Uint8Array;
    mac: Uint8Array;
}
/** The normal message without its MAC; the caller appends HMAC(authenticated)[0..8]. */
export declare function encodeNormalBody(ratchetKey: Uint8Array, chainIndex: number, ciphertext: Uint8Array): Uint8Array;
export declare function decodeNormal(bytes: Uint8Array): NormalMessage;
export interface PreKeyMessage {
    oneTimeKey: Uint8Array;
    baseKey: Uint8Array;
    identityKey?: Uint8Array;
    message: Uint8Array;
}
export declare function encodePreKey(m: {
    oneTimeKey: Uint8Array;
    baseKey: Uint8Array;
    identityKey: Uint8Array;
    message: Uint8Array;
}): Uint8Array;
export declare function decodePreKey(bytes: Uint8Array): PreKeyMessage;
export declare function withMac(authenticated: Uint8Array, mac: Uint8Array): Uint8Array;
