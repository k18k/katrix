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
  usage: string[];
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
