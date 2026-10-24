/**
 * Level 2 of the crypto stack: the Olm and Megolm protocols, as an interface the rest of the
 * client depends on. The built-in implementation (./native.ts) is written on CryptoPrimitives
 * only. Another implementation of the whole protocol, for example vodozemac through a native
 * module, can replace it without changes elsewhere: the shapes follow vodozemac's API (Account,
 * Session, GroupSession, InboundGroupSession), plaintexts are bytes, ciphertexts and keys are the
 * unpadded Base64 strings that go on the wire, and state leaves an object only as an opaque
 * pickle string.
 *
 * Synchronous, like vodozemac (and like libolm): the caller holds no lock across an await while a
 * ratchet advances, and an implementation backed by native code over JSI is synchronous too.
 *
 * Wire formats: https://gitlab.matrix.org/matrix-org/olm/-/blob/master/docs/olm.md and
 * …/megolm.md, as the Matrix spec requires for m.olm.v1.curve25519-aes-sha2 and
 * m.megolm.v1.aes-sha2 (https://spec.matrix.org/v1.16/client-server-api/#end-to-end-encryption).
 */

/** An Olm message as it appears in m.room.encrypted `ciphertext[recipient_key]`. */
export interface OlmMessage {
  /** 0: pre-key message (starts a session), 1: normal message. */
  readonly type: 0 | 1;
  /** Unpadded Base64. */
  readonly body: string;
}

export interface IdentityKeys {
  /** Unpadded Base64 Curve25519 public key. */
  readonly curve25519: string;
  /** Unpadded Base64 Ed25519 public key (the device's fingerprint key). */
  readonly ed25519: string;
}

/**
 * Encrypts pickles at rest when given (32 bytes). Without it, pickles are plain JSON and the
 * storage adapter is the only protection.
 */
export type PickleKey = Uint8Array;

export interface OlmAccount {
  identityKeys(): IdentityKeys;
  /** Ed25519 signature (unpadded Base64) of the UTF-8 bytes of `message`. */
  sign(message: string): string;
  /** How many one-time keys the account can hold that the server does not know yet. */
  maxNumberOfOneTimeKeys(): number;
  generateOneTimeKeys(count: number): void;
  /** Unpublished one-time keys: key ID → unpadded Base64 Curve25519 public key. */
  oneTimeKeys(): Record<string, string>;
  generateFallbackKey(): void;
  /** The unpublished fallback key, if any (same shape as oneTimeKeys). */
  fallbackKey(): Record<string, string>;
  /** Forget the previous fallback key; returns whether there was one. */
  forgetFallbackKey(): boolean;
  /** Mark the current one-time keys and fallback key as published (uploaded). */
  markKeysAsPublished(): void;
  /** An outbound session to a device with identity key `identityKey`, using its `oneTimeKey`. */
  createOutboundSession(identityKey: string, oneTimeKey: string): OlmSession;
  /**
   * An inbound session from a pre-key message. The one-time key it used is removed from the
   * account only when the embedded message decrypts (a fallback key is kept). Throws otherwise and
   * leaves the account unchanged.
   */
  createInboundSession(theirIdentityKey: string, message: OlmMessage): { session: OlmSession; plaintext: Uint8Array };
  pickle(key?: PickleKey): string;
}

export interface OlmSession {
  sessionId(): string;
  /** Whether a message from the other side was decrypted (until then, encrypt makes pre-key messages). */
  hasReceivedMessage(): boolean;
  encrypt(plaintext: Uint8Array): OlmMessage;
  /** Throws a ProtocolError and leaves the session unchanged if the message does not decrypt. */
  decrypt(message: OlmMessage): Uint8Array;
  /** Whether a pre-key message belongs to this session (same keys as the one that started it). */
  sessionMatches(message: OlmMessage): boolean;
  pickle(key?: PickleKey): string;
}

export interface OutboundGroupSession {
  /** Unpadded Base64 Ed25519 public key of the session. */
  sessionId(): string;
  /** The index of the next message encrypt will produce. */
  messageIndex(): number;
  /** The session key at the current index (m.room_key `session_key`), signed. */
  sessionKey(): string;
  /** Unpadded Base64 Megolm message. Advances the ratchet. */
  encrypt(plaintext: Uint8Array): string;
  pickle(key?: PickleKey): string;
}

export type SessionOrdering = "better" | "equal" | "worse" | "unconnected";

export interface InboundGroupSession {
  sessionId(): string;
  firstKnownIndex(): number;
  /**
   * Whether the session's Ed25519 key is authenticated by the session itself: true when it was
   * created from a signed session key (m.room_key), false from an export (forwarded keys, backup).
   */
  isSigningKeyVerified(): boolean;
  /** Throws a ProtocolError and leaves the session unchanged if the message does not decrypt. */
  decrypt(ciphertext: string): { plaintext: Uint8Array; messageIndex: number };
  /** The session exported at `index` (unsigned format), or undefined if index < firstKnownIndex. */
  exportAt(index: number): string | undefined;
  /** How this session compares to `other` with the same ID: better = knows earlier messages. */
  compare(other: InboundGroupSession): SessionOrdering;
  pickle(key?: PickleKey): string;
}

export interface E2EEProtocol {
  /** Names the implementation and its pickle format. Stored next to pickles. */
  readonly id: string;
  newAccount(): OlmAccount;
  accountFromPickle(pickle: string, key?: PickleKey): OlmAccount;
  sessionFromPickle(pickle: string, key?: PickleKey): OlmSession;
  newOutboundGroupSession(): OutboundGroupSession;
  outboundGroupSessionFromPickle(pickle: string, key?: PickleKey): OutboundGroupSession;
  /** From an m.room_key `session_key`; throws if its signature does not verify. */
  inboundGroupSessionFromSessionKey(sessionKey: string): InboundGroupSession;
  /** From an exported session (m.forwarded_room_key, key backup). */
  inboundGroupSessionFromExport(exported: string): InboundGroupSession;
  inboundGroupSessionFromPickle(pickle: string, key?: PickleKey): InboundGroupSession;
  /** Verify an Ed25519 signature (all unpadded Base64) over the UTF-8 bytes of `message`. */
  verifyEd25519(publicKey: string, message: string, signature: string): boolean;
}

/** Why a protocol operation failed. Never carries key material, plaintext or ciphertext. */
export type ProtocolErrorCode =
  | "BAD_MESSAGE_VERSION"
  | "BAD_MESSAGE_FORMAT"
  | "BAD_MESSAGE_MAC"
  | "BAD_SIGNATURE"
  | "BAD_MESSAGE_KEY_ID"
  | "MESSAGE_GAP_TOO_LARGE"
  | "UNKNOWN_ONE_TIME_KEY"
  | "SESSION_MISMATCH"
  | "UNKNOWN_MESSAGE_INDEX"
  | "BAD_SESSION_KEY"
  | "BAD_PUBLIC_KEY"
  | "BAD_PICKLE"
  | "BAD_PICKLE_KEY"
  | "BAD_DECRYPTION";

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ProtocolError";
    this.code = code;
  }
}
