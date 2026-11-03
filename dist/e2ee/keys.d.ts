import type { E2EEProtocol, OlmAccount } from "../protocol/protocol.ts";
export declare const OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";
export declare const MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2";
/** Add our device's signature to `obj` (https://spec.matrix.org/v1.16/appendices/#signing-json). */
export declare function signObject<T extends Record<string, unknown>>(account: OlmAccount, userId: string, deviceId: string, obj: T): T & {
    signatures: Record<string, Record<string, string>>;
};
/** Whether `obj` carries a valid signature by `userId`'s key `ed25519:<keyId>`. Never throws. */
export declare function verifyObject(protocol: E2EEProtocol, obj: Record<string, unknown>, userId: string, keyId: string, publicKey: string): boolean;
export declare function deviceKeysObject(account: OlmAccount, userId: string, deviceId: string): {
    user_id: string;
    device_id: string;
    algorithms: string[];
    keys: {
        [x: string]: string;
    };
} & {
    signatures: Record<string, Record<string, string>>;
};
/** The unpublished one-time and fallback keys, signed, as /keys/upload takes them. */
export declare function oneTimeKeysObject(account: OlmAccount, userId: string, deviceId: string): {
    oneTime: Record<string, unknown>;
    fallback: Record<string, unknown>;
};
