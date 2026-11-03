import type { CryptoPrimitives } from "../../crypto/primitives.ts";
import { type MegolmRatchet } from "./ratchet.ts";
export declare function encodeSessionKey(p: CryptoPrimitives, r: MegolmRatchet, signing: {
    secretKey: Uint8Array;
    publicKey: Uint8Array;
}): string;
export declare function encodeExport(r: MegolmRatchet, signingKey: Uint8Array): string;
export declare function decodeSessionKey(p: CryptoPrimitives, input: string): {
    ratchet: MegolmRatchet;
    signingKey: Uint8Array;
};
export declare function decodeExport(input: string): {
    ratchet: MegolmRatchet;
    signingKey: Uint8Array;
};
