/** End-to-end encryption keys and to-device messages (https://spec.matrix.org/v1.16/client-server-api/#end-to-end-encryption). */

export type Signatures = Record<string, Record<string, string>>;

export interface DeviceKeys {
  user_id: string;
  device_id: string;
  algorithms: string[];
  keys: Record<string, string>;
  signatures: Signatures;
  unsigned?: { device_display_name?: string; [key: string]: unknown };
}

/** A signed one-time or fallback key. */
export interface KeyObject {
  key: string;
  fallback?: boolean;
  signatures: Signatures;
}

export interface KeysUploadRequest {
  device_keys?: DeviceKeys;
  one_time_keys?: Record<string, KeyObject | string>;
  fallback_keys?: Record<string, KeyObject | string>;
}

export interface KeysUploadResponse {
  one_time_key_counts: Record<string, number>;
}

export interface KeysQueryRequest {
  device_keys: Record<string, string[]>;
  timeout?: number;
}

export interface CrossSigningKey {
  user_id: string;
  usage: Array<"master" | "self_signing" | "user_signing" | string>;
  keys: Record<string, string>;
  signatures?: Signatures;
}

export interface KeysQueryResponse {
  device_keys?: Record<string, Record<string, DeviceKeys>>;
  failures?: Record<string, unknown>;
  master_keys?: Record<string, CrossSigningKey>;
  self_signing_keys?: Record<string, CrossSigningKey>;
  user_signing_keys?: Record<string, CrossSigningKey>;
}

export interface KeysClaimRequest {
  /** user → device → algorithm. */
  one_time_keys: Record<string, Record<string, string>>;
  timeout?: number;
}

export interface KeysClaimResponse {
  /** user → device → "algorithm:key ID" → key. */
  one_time_keys: Record<string, Record<string, Record<string, KeyObject | string>>>;
  failures?: Record<string, unknown>;
}

/** PUT /sendToDevice/{eventType}/{txnId}: user → device ("*" for all) → content. */
export interface SendToDeviceRequest {
  messages: Record<string, Record<string, Record<string, unknown>>>;
}

export interface KeyChangesResponse {
  changed?: string[];
  left?: string[];
}

/** POST /keys/device_signing/upload (https://spec.matrix.org/v1.19/client-server-api/#cross-signing). */
export interface DeviceSigningUploadRequest {
  master_key?: CrossSigningKey;
  self_signing_key?: CrossSigningKey;
  user_signing_key?: CrossSigningKey;
  auth?: { type?: string; session?: string; [key: string]: unknown };
}

/** POST /keys/signatures/upload: user → key ID (a device ID, or a cross-signing public key) → the signed object. */
export type SignaturesUploadRequest = Record<string, Record<string, DeviceKeys | CrossSigningKey>>;

export interface SignaturesUploadResponse {
  failures?: Record<string, Record<string, { errcode: string; error?: string }>>;
}

/** Server-side key backup (https://spec.matrix.org/v1.19/client-server-api/#server-side-key-backups). */
export type BackupAlgorithm = "m.megolm_backup.v1.curve25519-aes-sha2" | (string & {});

export interface BackupAuthData {
  public_key: string;
  signatures?: Signatures;
  [key: string]: unknown;
}

export interface BackupVersionRequest {
  algorithm: BackupAlgorithm;
  auth_data: BackupAuthData;
  /** PUT only: must match the path when given. */
  version?: string;
}

export interface BackupVersionResponse {
  algorithm: BackupAlgorithm;
  auth_data: BackupAuthData;
  count: number;
  etag: string;
  version: string;
}

export interface CreateBackupVersionResponse {
  version: string;
}

/** The session data of m.megolm_backup.v1.curve25519-aes-sha2: the key, encrypted to the backup's public key. */
export interface EncryptedSessionData {
  ephemeral: string;
  ciphertext: string;
  mac: string;
  [key: string]: unknown;
}

export interface KeyBackupData {
  first_message_index: number;
  forwarded_count: number;
  is_verified: boolean;
  session_data: EncryptedSessionData;
}

export interface RoomKeyBackup {
  sessions: Record<string, KeyBackupData>;
}

export interface KeysBackup {
  rooms: Record<string, RoomKeyBackup>;
}

export interface BackupKeysUpdateResponse {
  etag: string;
  count: number;
}
