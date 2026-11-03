import { type KeyObject } from "node:crypto";
export declare function unpaddedBase64(buf: Uint8Array): string;
export declare function urlSafeBase64(buf: Uint8Array): string;
export declare function randomString(length: number): string;
export declare function randomToken(bytes?: number): string;
export declare function sha256(data: string | Uint8Array): Buffer;
export declare function hashPassword(password: string): Promise<string>;
export declare function verifyPassword(password: string, stored: string): Promise<boolean>;
export interface SigningKey {
    keyId: string;
    privateKey: KeyObject;
    publicKeyBase64: string;
    /** Unpadded base64 of the 32-byte ed25519 seed, for persistence. */
    seed: string;
}
export declare function loadSigningKey(keyId: string, seed?: string): SigningKey;
/** Sign a JSON object in place according to the Matrix signing algorithm. */
export declare function signJson<T extends Record<string, any>>(obj: T, serverName: string, key: SigningKey): T;
/** Decode unpadded (standard or URL-safe) base64. */
export declare function decodeBase64(s: string): Buffer;
export declare function publicKeyFromBase64(key: string): KeyObject;
/** Verify one ed25519 signature on a JSON object (signatures/unsigned excluded). */
export declare function verifyJsonSignature(obj: Record<string, any>, serverName: string, keyId: string, publicKey: KeyObject): boolean;
