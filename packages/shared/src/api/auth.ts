/**
 * Login, registration and the session
 * (https://spec.matrix.org/v1.16/client-server-api/#client-authentication). Requests are what a
 * client sends as the spec defines them; the server's body schemas accept at least these
 * (packages/server/test/types/shared-api.ts checks that at compile time).
 */

export interface VersionsResponse {
  versions: string[];
  unstable_features?: Record<string, boolean>;
}

/** GET /.well-known/matrix/client */
export interface WellKnownClient {
  "m.homeserver": { base_url: string };
  "m.identity_server"?: { base_url: string };
  [key: string]: unknown;
}

export interface LoginFlow {
  type: string;
  get_login_token?: boolean;
  identity_providers?: Array<{ id: string; name: string; icon?: string; brand?: string }>;
  [key: string]: unknown;
}

export interface LoginFlowsResponse {
  flows: LoginFlow[];
}

export type UserIdentifier =
  | { type: "m.id.user"; user: string }
  | { type: "m.id.thirdparty"; medium: string; address: string }
  | { type: "m.id.phone"; country: string; phone: string };

interface DeviceFields {
  device_id?: string;
  initial_device_display_name?: string;
  /** Ask for a refresh token (https://spec.matrix.org/v1.16/client-server-api/#refreshing-access-tokens). */
  refresh_token?: boolean;
}

export type LoginRequest = DeviceFields &
  (
    | { type: "m.login.password"; identifier: UserIdentifier; password: string }
    | { type: "m.login.token"; token: string }
    | { type: "m.login.application_service"; identifier: UserIdentifier }
  );

export interface LoginResponse {
  user_id: string;
  access_token: string;
  device_id: string;
  refresh_token?: string;
  expires_in_ms?: number;
  well_known?: WellKnownClient;
  /** Deprecated (the server name is part of user_id), still sent by servers. */
  home_server?: string;
}

/** The `auth` of a request that needs user-interactive authentication. */
export interface AuthenticationData {
  type?: string;
  session?: string;
  [key: string]: unknown;
}

/** A 401 that asks for (more) user-interactive authentication. */
export interface UserInteractiveAuthResponse {
  flows: Array<{ stages: string[] }>;
  params?: Record<string, unknown>;
  session?: string;
  completed?: string[];
}

export interface RegisterRequest extends DeviceFields {
  username?: string;
  password?: string;
  inhibit_login?: boolean;
  auth?: AuthenticationData;
}

export interface RegisterResponse {
  user_id: string;
  /** Deprecated, as in LoginResponse. */
  home_server?: string;
  access_token?: string;
  device_id?: string;
  refresh_token?: string;
  expires_in_ms?: number;
}

export interface RefreshRequest {
  refresh_token: string;
}

export interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in_ms?: number;
}

export interface WhoamiResponse {
  user_id: string;
  device_id?: string;
  is_guest?: boolean;
}

/** GET /_matrix/client/v1/auth_metadata (https://spec.matrix.org/v1.16/client-server-api/#oauth-20-api). */
export interface AuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  response_modes_supported?: string[];
  code_challenge_methods_supported?: string[];
  [key: string]: unknown;
}
