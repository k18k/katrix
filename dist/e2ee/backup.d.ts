import { CryptoPrimitives } from "../crypto/primitives.js";
import { MatrixHttpApi } from "../http/api.js";
import { E2EEProtocol } from "../protocol/protocol.js";
import { Store } from "../storage/store.js";
import { Logger } from "../util/logger.js";
import { BackupVersionResponse, EncryptedSessionData } from "../shared/api/keys.js";
import { Pickler } from "./crypto-store.js";
import { CrossSigning } from "./cross-signing.js";
import { DeviceTracker } from "./devices.js";
import { SecretBox } from "./secret-box.js";
/** The plaintext of a backed-up session (BackedUpSessionData). */
export interface BackedUpSession {
  algorithm: string;
  /** Optional: backups made by other clients may leave it out. */
  forwarding_curve25519_key_chain?: string[];
  sender_key: string;
  /** Optional: backups made by other clients may leave it out. */
  sender_claimed_keys?: Record<string, string>;
  session_key: string;
  shared_history?: boolean;
}
/**
 * Encrypt a session for m.megolm_backup.v1.curve25519-aes-sha2, by the spec's steps: an ephemeral
 * X25519 key agreement with the backup key, HKDF-SHA-256 into AES-256-CBC key, MAC key and IV.
 * The MAC is of the empty string, not the ciphertext: a bug in libolm every implementation now
 * shares (the spec's warning, MSC4048), so it only shows that the keys were derived right.
 */
export declare function encryptBackupSession(primitives: CryptoPrimitives, backupPublicKey: Uint8Array, session: BackedUpSession): {
  ephemeral: string;
  ciphertext: string;
  mac: string;
};
export declare function decryptBackupSession(primitives: CryptoPrimitives, backupPrivateKey: Uint8Array, data: EncryptedSessionData): BackedUpSession;
/**
 * Server-side key backup (https://spec.matrix.org/v1.19/client-server-api/#server-side-key-backups):
 * room keys are uploaded encrypted to a public key whose private half only the user has (in
 * secret storage, or shared from another device), so a new device can read old messages.
 *
 * Keys are only uploaded to a backup whose auth_data is trusted: signed by the user's master key
 * or one of their verified devices, or whose private key this device holds.
 */
export declare class KeyBackup {
  private readonly api;
  private readonly store;
  private readonly primitives;
  private readonly protocol;
  private readonly pickler;
  private readonly devices;
  private readonly crossSigning;
  private readonly box;
  private readonly logger;
  private readonly userId;
  private readonly signWithDevice;
  private readonly uploadMutex;
  constructor(opts: {
    api: MatrixHttpApi;
    store: Store;
    primitives: CryptoPrimitives;
    protocol: E2EEProtocol;
    pickler: Pickler;
    devices: DeviceTracker;
    crossSigning: CrossSigning;
    box: SecretBox;
    logger: Logger;
    userId: string;
    signWithDevice: <T extends object>(obj: T) => Promise<T>;
  });
  /** The server's current backup, if there is one. */
  serverInfo(): Promise<BackupVersionResponse | undefined>;
  /** The backup this device uploads to, if any. */
  active(): Promise<{
    version: string;
    publicKey: string;
    hasPrivateKey: boolean;
  } | undefined>;
  /** The backup's private key, if this device has it (to put it in secret storage). */
  privateKey(): Promise<Uint8Array<ArrayBufferLike> | undefined>;
  /**
   * Create a new backup (the server's current one is replaced as the place keys go) and start
   * uploading every room key to it. Its auth_data is signed by this device, and by the master
   * key when given. Records the user's choice in m.key_backup (v1.19). Resolves with the
   * private key, for the app to put in secret storage.
   */
  create(opts?: {
    masterKey?: Uint8Array;
  }): Promise<{
    version: string;
    privateKey: Uint8Array<ArrayBufferLike>;
  }>;
  /**
   * Use the server's current backup with its private key (from secret storage, secret sharing,
   * or typed in by the user). The key must match the backup's public key.
   */
  enableWithPrivateKey(privateKey: Uint8Array): Promise<string>;
  /** Upload to the server's current backup without its private key, if its auth_data is trusted. Resolves whether it is. */
  enableIfTrusted(): Promise<boolean>;
  private activate;
  /** Stop uploading (the backup stays on the server). */
  disable(): Promise<void>;
  /** Delete a backup version on the server (and stop using it here, if it was the active one). */
  deleteVersion(version: string): Promise<void>;
  /**
   * Whether a backup's auth_data is trusted: signed by our trusted master key or by one of our
   * verified devices (spec: "Clients must only store keys in backups after they have ensured
   * that the auth_data is trusted").
   */
  isTrusted(info: BackupVersionResponse): Promise<boolean>;
  /**
   * Upload the room keys not yet in the active backup, in batches. A backup replaced on the
   * server (M_WRONG_ROOM_KEYS_VERSION) stops the uploads until the app enables the new one.
   */
  backupPending(): Promise<number>;
  /** One session or one room goes to its own endpoint (a smaller request); more go to PUT /room_keys/keys. */
  private upload;
  /** One backup version's information. */
  versionInfo(version: string): Promise<BackupVersionResponse | undefined>;
  /**
   * Add the master key's signature to the current backup's auth_data (after cross-signing was
   * set up or reset, so other devices trust the backup through the identity).
   */
  signWithMasterKey(masterKey: Uint8Array): Promise<void>;
  /** Delete backed-up keys on the server: all of them, one room's, or one session. */
  deleteKeys(opts?: {
    roomId?: string;
    sessionId?: string;
  }): Promise<void>;
  private sessionData;
  /**
   * Download and import keys from the server's backup (all, one room's, or one session), with
   * the private key given or the one this device has. Keys already known from an earlier index
   * are kept. Resolves with the sessions imported, for the client to retry decryption.
   */
  restore(opts?: {
    privateKey?: Uint8Array;
    roomId?: string;
    sessionId?: string;
  }): Promise<{
    roomId: string;
    sessionId: string;
  }[]>;
}
//# sourceMappingURL=backup.d.ts.map