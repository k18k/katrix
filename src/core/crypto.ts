import {
  createHash,
  verify,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  scrypt,
  sign,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { promisify } from "node:util";
import { canonicalJson } from "#core/json.ts";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export function unpaddedBase64(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "");
}

export function urlSafeBase64(buf: Uint8Array): string {
  return unpaddedBase64(buf).replace(/\+/g, "-").replace(/\//g, "_");
}

// Security (https://github.com/k18k/matrix-nodejs-homeserver/issues/5): this used `byte % 52`, which made some letters more likely than others
// (modulo bias, CWE-1241) in nonces, session IDs and tokens. randomInt samples uniformly.
export function randomString(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export function randomToken(bytes = 32): string {
  return urlSafeBase64(randomBytes(bytes));
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize("NFKC"), salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scryptAsync(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

export interface SigningKey {
  keyId: string;
  privateKey: KeyObject;
  publicKeyBase64: string;
  /** Unpadded base64 of the 32-byte ed25519 seed, for persistence. */
  seed: string;
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function loadSigningKey(keyId: string, seed?: string): SigningKey {
  let privateKey: KeyObject;
  if (seed) {
    const raw = Buffer.from(seed, "base64");
    privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]), format: "der", type: "pkcs8" });
  } else {
    privateKey = generateKeyPairSync("ed25519").privateKey;
  }
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const rawSeed = der.subarray(der.length - 32);
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const rawPub = spki.subarray(spki.length - 32);
  return { keyId, privateKey, publicKeyBase64: unpaddedBase64(rawPub), seed: unpaddedBase64(rawSeed) };
}

/** Sign a JSON object in place according to the Matrix signing algorithm. */
export function signJson<T extends Record<string, any>>(obj: T, serverName: string, key: SigningKey): T {
  const { signatures, unsigned, ...rest } = obj;
  const sig = unpaddedBase64(sign(null, Buffer.from(canonicalJson(rest)), key.privateKey));
  const merged = { ...signatures };
  merged[serverName] = { ...merged[serverName], [`ed25519:${key.keyId}`]: sig };
  (obj as any).signatures = merged;
  return obj;
}

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Decode unpadded (standard or URL-safe) base64. */
export function decodeBase64(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function publicKeyFromBase64(key: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, decodeBase64(key)]), format: "der", type: "spki" });
}

/** Verify one ed25519 signature on a JSON object (signatures/unsigned excluded). */
export function verifyJsonSignature(obj: Record<string, any>, serverName: string, keyId: string, publicKey: KeyObject): boolean {
  const sig = obj.signatures?.[serverName]?.[keyId];
  if (typeof sig !== "string") return false;
  const { signatures, unsigned, ...rest } = obj;
  try {
    return verify(null, Buffer.from(canonicalJson(rest)), publicKey, decodeBase64(sig));
  } catch {
    return false;
  }
}
