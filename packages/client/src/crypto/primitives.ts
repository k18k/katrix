/**
 * Level 1 of the crypto stack: the primitives everything above is built from. Olm and Megolm
 * (src/protocol) and, later, SAS verification, cross-signing, key backup and secret storage use
 * nothing else. The default implementation is on @noble/* (./noble.ts); a platform can supply
 * its own (for example native code in a React Native app) as long as it meets these contracts.
 *
 * The interface is synchronous on purpose. Hermes has no WebCrypto (crypto.subtle), so the
 * portable implementations are synchronous anyway, and the protocol layer mirrors vodozemac's API,
 * which is synchronous too: an async primitive could not be used underneath it.
 *
 * Errors thrown by an implementation must not contain key material or plaintext.
 */

export interface KeyPair {
  /** 32 bytes. For Ed25519 this is the RFC 8032 seed, not the expanded secret key. */
  readonly secretKey: Uint8Array;
  /** 32 bytes. */
  readonly publicKey: Uint8Array;
}

export interface CryptoPrimitives {
  /** Cryptographically secure random bytes. */
  randomBytes(length: number): Uint8Array;

  sha256(data: Uint8Array): Uint8Array;
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  /** HKDF-SHA-256 (RFC 5869). An empty or missing salt means HashLen zero bytes, as in the RFC. */
  hkdfSha256(ikm: Uint8Array, salt: Uint8Array | undefined, info: Uint8Array, length: number): Uint8Array;

  /** X25519 (RFC 7748). */
  x25519GenerateKeyPair(): KeyPair;
  x25519PublicKey(secretKey: Uint8Array): Uint8Array;
  /** Throws for a low-order public key (an all-zero shared secret), which contributes nothing. */
  x25519SharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array;

  /** Ed25519 (RFC 8032), on 32-byte seeds. */
  ed25519GenerateKeyPair(): KeyPair;
  ed25519PublicKey(seed: Uint8Array): Uint8Array;
  ed25519Sign(seed: Uint8Array, message: Uint8Array): Uint8Array;
  /** Strict verification (RFC 8032 §5.1.7, canonical encodings only). Never throws: false. */
  ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;

  /** AES-256-CBC with PKCS#7 padding. */
  aes256CbcEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** Throws on a length that is not a multiple of the block size or on invalid padding. */
  aes256CbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  /** AES-256-CTR with a 128-bit big-endian counter block; the same call encrypts and decrypts. */
  aes256Ctr(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array;
}

export class CryptoPrimitiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoPrimitiveError";
  }
}
