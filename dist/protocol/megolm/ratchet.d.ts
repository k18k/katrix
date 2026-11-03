import type { CryptoPrimitives } from "../../crypto/primitives.ts";
export declare const RATCHET_LENGTH = 128;
export interface MegolmRatchet {
    /** R_0…R_3. */
    parts: Uint8Array[];
    counter: number;
}
export declare function ratchetFromBytes(bytes: Uint8Array, counter: number): MegolmRatchet;
export declare function ratchetBytes(r: MegolmRatchet): Uint8Array;
export declare function copyRatchet(r: MegolmRatchet): MegolmRatchet;
/** One step: i → i+1. */
export declare function advance(p: CryptoPrimitives, r: MegolmRatchet): void;
/** Jump forward to `index` (≥ the current counter; the caller checks). */
export declare function advanceTo(p: CryptoPrimitives, r: MegolmRatchet, index: number): void;
/** AES_KEY ‖ HMAC_KEY ‖ AES_IV = HKDF(0, R_i, "MEGOLM_KEYS", 80). */
export declare function messageKeys(p: CryptoPrimitives, r: MegolmRatchet): {
    aes: Uint8Array<ArrayBuffer>;
    mac: Uint8Array<ArrayBuffer>;
    iv: Uint8Array<ArrayBuffer>;
};
