import { CryptoPrimitives } from "../crypto/primitives.js";
export interface SecretStorageKeyDescription {
  name?: string;
  algorithm: string;
  passphrase?: {
    algorithm: "m.pbkdf2" | string;
    salt: string;
    iterations: number;
    bits?: number;
  };
  iv?: string;
  mac?: string;
}
export declare class SecretStorageError extends Error {
  readonly code: "NO_KEY" | "BAD_KEY" | "BAD_MAC" | "UNSUPPORTED" | "BAD_RECOVERY_KEY";
  constructor(code: SecretStorageError["code"], message: string);
}
/** Account data access: synced (or fetched) reads, and writes. */
export interface AccountDataAccess {
  get(type: string): Promise<Record<string, unknown> | undefined>;
  set(type: string, content: Record<string, unknown>): Promise<void>;
}
/** A 32-byte key as a recovery key (https://spec.matrix.org/v1.19/appendices/#cryptographic-key-representation). */
export declare function encodeRecoveryKey(key: Uint8Array): string;
/** Whitespace is ignored; a wrong prefix, length, character or parity is refused. */
export declare function decodeRecoveryKey(text: string): Uint8Array<ArrayBuffer>;
export declare class SecretStorage {
  private readonly primitives;
  private readonly accountData;
  constructor(primitives: CryptoPrimitives, accountData: AccountDataAccess);
  defaultKeyId(): Promise<string | undefined>;
  keyDescription(keyId?: string): Promise<{
    keyId: string;
    description: SecretStorageKeyDescription;
  } | undefined>;
  /**
   * Create a secret storage key, made the default unless `setDefault: false`. With a
   * passphrase, the key is derived from it (PBKDF2-SHA-512, 500 000 iterations, as other clients
   * use); either way the returned recovery key opens it too.
   */
  createKey(opts?: {
    passphrase?: string;
    name?: string;
    setDefault?: boolean;
  }): Promise<{
    keyId: string;
    key: Uint8Array<ArrayBufferLike>;
    recoveryKey: string;
  }>;
  private deriveKey;
  /** The key a passphrase stands for, by the key's description. */
  keyFromPassphrase(passphrase: string, keyId?: string): Promise<Uint8Array<ArrayBufferLike>>;
  /** Whether `key` is the key with this ID (by its check MAC; a key description without one accepts any key). */
  checkKey(key: Uint8Array, keyId?: string): Promise<boolean>;
  /** Encrypt a secret (a string, as the spec has them) under a key and store it in account data. */
  store(name: string, secret: string, key: Uint8Array, keyId?: string): Promise<void>;
  /** A stored secret, decrypted; undefined when it is not stored under that key. */
  get(name: string, key: Uint8Array, keyId?: string): Promise<string | undefined>;
  /** The key IDs a secret is stored under. */
  storedUnder(name: string): Promise<string[]>;
}
//# sourceMappingURL=secret-storage.d.ts.map