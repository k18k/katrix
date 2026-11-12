import type { ClientEvent } from "../events.ts";
import type { AuthenticationData } from "./auth.ts";

/**
 * The account and what belongs to it: password, deactivation, third-party IDs, devices, filters,
 * presence, tags, OpenID, capabilities, and the server administration endpoints
 * (https://spec.matrix.org/v1.19/client-server-api/#account-registration-and-management).
 */

export interface ChangePasswordRequest {
  new_password: string;
  /** Default true: every other device is logged out. */
  logout_devices?: boolean;
  auth?: AuthenticationData;
}

export interface DeactivateRequest {
  auth?: AuthenticationData;
  id_server?: string;
  erase?: boolean;
}

export interface UnbindResultResponse {
  id_server_unbind_result: "success" | "no-support";
}

export type ThreePidMedium = "email" | "msisdn";

export interface ThirdPartyIdentifier {
  medium: ThreePidMedium;
  address: string;
  validated_at: number;
  added_at: number;
}

export interface ThreePidsResponse {
  threepids?: ThirdPartyIdentifier[];
}

export interface AddThreePidRequest {
  auth?: AuthenticationData;
  client_secret: string;
  sid: string;
}

export interface BindThreePidRequest {
  client_secret: string;
  id_server: string;
  id_access_token: string;
  sid: string;
}

export interface DeleteThreePidRequest {
  id_server?: string;
  medium: ThreePidMedium;
  address: string;
}

/** POST …/email/requestToken (registration, password reset, adding an address). */
export interface EmailTokenRequest {
  client_secret: string;
  email: string;
  send_attempt: number;
  next_link?: string;
  id_server?: string;
  id_access_token?: string;
}

/** POST …/msisdn/requestToken. */
export interface MsisdnTokenRequest {
  client_secret: string;
  country: string;
  phone_number: string;
  send_attempt: number;
  next_link?: string;
  id_server?: string;
  id_access_token?: string;
}

export interface RequestTokenResponse {
  sid: string;
  submit_url?: string;
}

export interface Device {
  device_id: string;
  display_name?: string;
  last_seen_ip?: string;
  last_seen_ts?: number;
}

export interface DevicesResponse {
  devices?: Device[];
}

export interface UpdateDeviceRequest {
  display_name?: string;
}

export interface DeleteDeviceRequest {
  auth?: AuthenticationData;
}

export interface DeleteDevicesRequest {
  devices: string[];
  auth?: AuthenticationData;
}

export interface LoginTokenRequest {
  auth?: AuthenticationData;
}

export interface LoginTokenResponse {
  login_token: string;
  expires_in_ms: number;
}

export interface OpenIdToken {
  access_token: string;
  token_type: string;
  matrix_server_name: string;
  expires_in: number;
}

/** GET /capabilities (https://spec.matrix.org/v1.19/client-server-api/#capabilities-negotiation). */
export interface Capabilities {
  "m.change_password"?: { enabled: boolean };
  "m.forget_forced_upon_leave"?: { enabled: boolean };
  "m.room_versions"?: { default: string; available: Record<string, "stable" | "unstable" | string> };
  "m.set_displayname"?: { enabled: boolean };
  "m.set_avatar_url"?: { enabled: boolean };
  "m.3pid_changes"?: { enabled: boolean };
  "m.get_login_token"?: { enabled: boolean };
  "m.profile_fields"?: { enabled: boolean; allowed?: string[]; disallowed?: string[] };
  "m.account_moderation"?: { suspend?: boolean; lock?: boolean };
  [key: string]: unknown;
}

export interface CapabilitiesResponse {
  capabilities: Capabilities;
}

/** Event filters (https://spec.matrix.org/v1.19/client-server-api/#filtering). */
export interface EventFilter {
  limit?: number;
  not_senders?: string[];
  not_types?: string[];
  senders?: string[];
  types?: string[];
}

export interface RoomEventFilter extends EventFilter {
  unread_thread_notifications?: boolean;
  lazy_load_members?: boolean;
  include_redundant_members?: boolean;
  not_rooms?: string[];
  rooms?: string[];
  contains_url?: boolean;
}

export interface RoomFilter {
  not_rooms?: string[];
  rooms?: string[];
  ephemeral?: RoomEventFilter;
  include_leave?: boolean;
  state?: RoomEventFilter;
  timeline?: RoomEventFilter;
  account_data?: RoomEventFilter;
}

export interface Filter {
  event_fields?: string[];
  event_format?: "client" | "federation";
  presence?: EventFilter;
  account_data?: EventFilter;
  room?: RoomFilter;
}

export interface CreateFilterResponse {
  filter_id: string;
}

export type PresenceState = "online" | "offline" | "unavailable";

export interface SetPresenceRequest {
  presence: PresenceState;
  status_msg?: string;
}

export interface PresenceResponse {
  presence: PresenceState;
  last_active_ago?: number;
  status_msg?: string | null;
  currently_active?: boolean;
}

export interface TagsResponse {
  tags?: Record<string, { order?: number }>;
}

export interface TagRequest {
  order?: number;
}

export interface TurnServerResponse {
  username: string;
  password: string;
  uris: string[];
  ttl: number;
}

/** GET /admin/whois/{userId}. */
export interface WhoisResponse {
  user_id?: string;
  devices?: Record<string, { sessions?: Array<{ connections?: Array<{ ip?: string; last_seen?: number; user_agent?: string }> }> }>;
}

export interface SuspendBody {
  suspended: boolean;
}

export interface LockBody {
  locked: boolean;
}

export interface AppservicePingRequest {
  transaction_id?: string;
}

export interface AppservicePingResponse {
  duration_ms: number;
}

/** GET /rooms/{roomId}/initialSync: a room's state and latest messages, for peeking. */
export interface RoomInitialSyncResponse {
  room_id: string;
  membership?: "invite" | "join" | "leave" | "ban";
  messages?: { start?: string; end: string; chunk: ClientEvent[] };
  state?: ClientEvent[];
  visibility?: "private" | "public";
  account_data?: Array<{ type: string; content: Record<string, unknown> }>;
}
