import type { CryptoPrimitives } from "../crypto/primitives.ts";
import { decodeBase58, encodeBase58 } from "../util/base58.ts";
import { Base64Error, constantTimeEqual, decodeBase64, encodeBase64, encodeUtf8, decodeUtf8 } from "@katrix/shared";

/**
 * Secret storage (https://spec.matrix.org/v1.19/client-server-api/#storage): secrets (the
 * cross-signing private keys, the key backup's private key) encrypted in the user's account data
 * with a key only the user has: a recovery key, or one derived from a passphrase.
 */

export const SSSS_ALGORITHM = "m.secret_storage.v1.aes-hmac-sha2";

export interface SecretStorageKeyDescription {
  name?: string;
  algorithm: string;
  passphrase?: { algorithm: "m.pbkdf2" | string; salt: string; iterations: number; bits?: number };
  iv?: string;
  mac?: string;
}

interface EncryptedSecret {
  iv: string;
  ciphertext: string;
  mac: string;
}

export class SecretStorageError extends Error {
  readonly code: "NO_KEY" | "BAD_KEY" | "BAD_MAC" | "UNSUPPORTED" | "BAD_RECOVERY_KEY";
  constructor(code: SecretStorageError["code"], message: string) {
    super(message);
    this.name = "SecretStorageError";
    this.code = code;
  }
}

/** Account data access: synced (or fetched) reads, and writes. */
export interface AccountDataAccess {
  get(type: string): Promise<Record<string, unknown> | undefined>;
  set(type: string, content: Record<string, unknown>): Promise<void>;
}

const RECOVERY_KEY_PREFIX = [0x8b, 0x01];

/** A 32-byte key as a recovery key (https://spec.matrix.org/v1.19/appendices/#cryptographic-key-representation). */
export function encodeRecoveryKey(key: Uint8Array): string {
  const bytes = new Uint8Array(35);
  bytes.set(RECOVERY_KEY_PREFIX, 0);
  bytes.set(key, 2);
  let parity = 0;
  for (let i = 0; i < 34; i++) parity ^= bytes[i];
  bytes[34] = parity;
  return encodeBase58(bytes).replace(/(.{4})(?!$)/g, "$1 ");
}

/** Whitespace is ignored; a wrong prefix, length, character or parity is refused. */
export function decodeRecoveryKey(text: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase58(text.replace(/\s+/g, ""));
  } catch {
    throw new SecretStorageError("BAD_RECOVERY_KEY", "The recovery key has an invalid character");
  }
  let parity = 0;
  for (const b of bytes) parity ^= b;
  if (bytes.length !== 35 || bytes[0] !== RECOVERY_KEY_PREFIX[0] || bytes[1] !== RECOVERY_KEY_PREFIX[1] || parity !== 0)
    throw new SecretStorageError("BAD_RECOVERY_KEY", "This is not a valid recovery key");
  return bytes.slice(2, 34);
}

const ZERO_SALT = new Uint8Array(32);

function decode(value: unknown): Uint8Array {
  if (typeof value !== "string") throw new SecretStorageError("UNSUPPORTED", "Malformed encrypted secret");
  try {
    return decodeBase64(value);
  } catch (e) {
    if (e instanceof Base64Error) throw new SecretStorageError("UNSUPPORTED", "Malformed encrypted secret");
    throw e;
  }
}

/** m.secret_storage.v1.aes-hmac-sha2, as the spec describes it step by step. */
export function encryptSecret(
  primitives: CryptoPrimitives,
  key: Uint8Array,
  name: string,
  plaintext: Uint8Array,
  iv?: Uint8Array,
): EncryptedSecret {
  const okm = primitives.hkdfSha256(key, ZERO_SALT, encodeUtf8(name), 64);
  const theIv = iv ?? primitives.randomBytes(16);
  // "Set bit 63 to 0": the top bit of the counter half, so no AES-CTR implementation overflows it.
  theIv[8] &= 0x7f;
  const ciphertext = primitives.aes256Ctr(okm.subarray(0, 32), theIv, plaintext);
  const mac = primitives.hmacSha256(okm.subarray(32), ciphertext);
  return { iv: encodeBase64(theIv), ciphertext: encodeBase64(ciphertext), mac: encodeBase64(mac) };
}

export function decryptSecret(primitives: CryptoPrimitives, key: Uint8Array, name: string, data: EncryptedSecret): Uint8Array {
  const iv = decode(data.iv);
  const ciphertext = decode(data.ciphertext);
  const mac = decode(data.mac);
  if (iv.length !== 16) throw new SecretStorageError("UNSUPPORTED", "Malformed encrypted secret");
  const okm = primitives.hkdfSha256(key, ZERO_SALT, encodeUtf8(name), 64);
  if (!constantTimeEqual(primitives.hmacSha256(okm.subarray(32), ciphertext), mac))
    throw new SecretStorageError("BAD_MAC", "The secret does not decrypt with this key");
  return primitives.aes256Ctr(okm.subarray(0, 32), iv, ciphertext);
}

export class SecretStorage {
  private readonly primitives: CryptoPrimitives;
  private readonly accountData: AccountDataAccess;

  constructor(primitives: CryptoPrimitives, accountData: AccountDataAccess) {
    this.primitives = primitives;
    this.accountData = accountData;
  }

  async defaultKeyId(): Promise<string | undefined> {
    const key = (await this.accountData.get("m.secret_storage.default_key"))?.key;
    return typeof key === "string" ? key : undefined;
  }

  async keyDescription(keyId?: string): Promise<{ keyId: string; description: SecretStorageKeyDescription } | undefined> {
    const id = keyId ?? (await this.defaultKeyId());
    if (!id) return undefined;
    const description = (await this.accountData.get(`m.secret_storage.key.${id}`)) as SecretStorageKeyDescription | undefined;
    return description ? { keyId: id, description } : undefined;
  }

  /**
   * Create a secret storage key, made the default unless `setDefault: false`. With a
   * passphrase, the key is derived from it (PBKDF2-SHA-512, 500 000 iterations, as other clients
   * use); either way the returned recovery key opens it too.
   */
  async createKey(
    opts: { passphrase?: string; name?: string; setDefault?: boolean } = {},
  ): Promise<{ keyId: string; key: Uint8Array; recoveryKey: string }> {
    let key: Uint8Array;
    let passphrase: SecretStorageKeyDescription["passphrase"];
    if (opts.passphrase !== undefined) {
      const salt = encodeBase64(this.primitives.randomBytes(24));
      passphrase = { algorithm: "m.pbkdf2", salt, iterations: 500_000, bits: 256 };
      key = this.deriveKey(opts.passphrase, passphrase);
    } else key = this.primitives.randomBytes(32);
    const keyId = encodeBase64(this.primitives.randomBytes(24), { urlSafe: true });
    const check = encryptSecret(this.primitives, key, "", new Uint8Array(32));
    const description: SecretStorageKeyDescription = {
      algorithm: SSSS_ALGORITHM,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(passphrase ? { passphrase } : {}),
      iv: check.iv,
      mac: check.mac,
    };
    await this.accountData.set(`m.secret_storage.key.${keyId}`, description as unknown as Record<string, unknown>);
    if (opts.setDefault !== false) await this.accountData.set("m.secret_storage.default_key", { key: keyId });
    return { keyId, key, recoveryKey: encodeRecoveryKey(key) };
  }

  private deriveKey(passphrase: string, p: NonNullable<SecretStorageKeyDescription["passphrase"]>): Uint8Array {
    if (p.algorithm !== "m.pbkdf2") throw new SecretStorageError("UNSUPPORTED", `Unsupported passphrase algorithm ${p.algorithm}`);
    const bits = p.bits ?? 256;
    if (bits !== 256) throw new SecretStorageError("UNSUPPORTED", "Only 256-bit passphrase keys are supported");
    return this.primitives.pbkdf2Sha512(encodeUtf8(passphrase), encodeUtf8(p.salt), p.iterations, 32);
  }

  /** The key a passphrase stands for, by the key's description. */
  async keyFromPassphrase(passphrase: string, keyId?: string): Promise<Uint8Array> {
    const found = await this.keyDescription(keyId);
    if (!found?.description.passphrase) throw new SecretStorageError("NO_KEY", "The key has no passphrase");
    return this.deriveKey(passphrase, found.description.passphrase);
  }

  /** Whether `key` is the key with this ID (by its check MAC; a key description without one accepts any key). */
  async checkKey(key: Uint8Array, keyId?: string): Promise<boolean> {
    const found = await this.keyDescription(keyId);
    if (!found) throw new SecretStorageError("NO_KEY", "No such secret storage key");
    const d = found.description;
    if (d.algorithm !== SSSS_ALGORITHM) throw new SecretStorageError("UNSUPPORTED", `Unsupported secret storage algorithm ${d.algorithm}`);
    if (d.iv === undefined || d.mac === undefined) return true;
    const check = encryptSecret(this.primitives, key, "", new Uint8Array(32), decode(d.iv));
    return constantTimeEqual(decode(check.mac), decode(d.mac));
  }

  /** Encrypt a secret (a string, as the spec has them) under a key and store it in account data. */
  async store(name: string, secret: string, key: Uint8Array, keyId?: string): Promise<void> {
    const id = keyId ?? (await this.defaultKeyId());
    if (!id) throw new SecretStorageError("NO_KEY", "No default secret storage key");
    if (!(await this.checkKey(key, id))) throw new SecretStorageError("BAD_KEY", "That is not the secret storage key");
    const existing = (await this.accountData.get(name))?.encrypted;
    await this.accountData.set(name, {
      encrypted: {
        ...(typeof existing === "object" && existing ? existing : {}),
        [id]: encryptSecret(this.primitives, key, name, encodeUtf8(secret)),
      },
    });
  }

  /** A stored secret, decrypted; undefined when it is not stored under that key. */
  async get(name: string, key: Uint8Array, keyId?: string): Promise<string | undefined> {
    const id = keyId ?? (await this.defaultKeyId());
    if (!id) throw new SecretStorageError("NO_KEY", "No default secret storage key");
    const encrypted = (await this.accountData.get(name))?.encrypted as Record<string, EncryptedSecret> | undefined;
    const data = encrypted?.[id];
    if (!data) return undefined;
    return decodeUtf8(decryptSecret(this.primitives, key, name, data));
  }

  /** The key IDs a secret is stored under. */
  async storedUnder(name: string): Promise<string[]> {
    const encrypted = (await this.accountData.get(name))?.encrypted;
    return typeof encrypted === "object" && encrypted !== null ? Object.keys(encrypted) : [];
  }
}
