import type { CryptoPrimitives } from "../../crypto/primitives.ts";
import { type IdentityKeys, type OlmAccount, type OlmMessage, type OlmSession, type PickleKey } from "../protocol.ts";
/**
 * An Olm account: the device's identity keys (Curve25519 for Olm, Ed25519 for signatures), its
 * one-time keys and its fallback key.
 *
 * One-time keys: at most 100 are kept, the oldest dropped first; of those, 50 (half, as in libolm
 * and vodozemac) may be published at a time, so a key the server still hands out is still here.
 * Fallback keys: the current one and the one before it are kept, as a pre-key message for the
 * previous key may still be in flight when a new one is published.
 */
export declare const MAX_ONE_TIME_KEYS = 100;
export declare class NativeOlmAccount implements OlmAccount {
    private readonly p;
    private curve25519;
    private ed25519;
    private oneTime;
    private nextKeyId;
    private fallback?;
    private previousFallback?;
    private constructor();
    static create(p: CryptoPrimitives): NativeOlmAccount;
    identityKeys(): IdentityKeys;
    sign(message: string): string;
    maxNumberOfOneTimeKeys(): number;
    generateOneTimeKeys(count: number): void;
    oneTimeKeys(): Record<string, string>;
    generateFallbackKey(): void;
    fallbackKey(): Record<string, string>;
    forgetFallbackKey(): boolean;
    markKeysAsPublished(): void;
    createOutboundSession(identityKey: string, oneTimeKey: string): OlmSession;
    createInboundSession(theirIdentityKey: string, message: OlmMessage): {
        session: OlmSession;
        plaintext: Uint8Array;
    };
    private findKey;
    pickle(key?: PickleKey): string;
    static fromPickle(p: CryptoPrimitives, pickle: string, key?: PickleKey): NativeOlmAccount;
}
