import type {
  AuthMetadata,
  LoginFlowsResponse,
  LoginRequest,
  LoginResponse,
  RefreshRequest,
  RefreshResponse,
  RegisterRequest,
  RegisterResponse,
  VersionsResponse,
  WhoamiResponse,
} from "./auth.ts";
import type {
  KeysClaimRequest,
  KeysClaimResponse,
  KeysQueryRequest,
  KeysQueryResponse,
  KeysUploadRequest,
  KeysUploadResponse,
  SendToDeviceRequest,
} from "./keys.ts";
import type {
  CreateRoomRequest,
  DelayedEventResponse,
  CreateRoomResponse,
  JoinRequest,
  JoinResponse,
  LeaveRequest,
  MembersResponse,
  MembershipRequest,
  MessagesResponse,
  ProfileResponse,
  ReceiptRequest,
  RedactRequest,
  SendEventResponse,
  SetDisplayNameRequest,
  TypingRequest,
} from "./rooms.ts";
import type { SyncResponse } from "./sync.ts";

/**
 * The Client-Server API endpoints both packages use, by `"METHOD /path"` under /_matrix/client
 * (`:name` marks a path parameter): what the request body is and what the response is. The
 * client builds its requests from this map (MatrixHttpApi.endpoint), and the server checks its
 * responses against it, so the two cannot drift apart.
 *
 * `request: undefined` means no body. Query parameters are not part of the map.
 */
export interface ClientEndpoints {
  "GET /versions": { request: undefined; response: VersionsResponse };
  "GET /v1/auth_metadata": { request: undefined; response: AuthMetadata };
  "GET /v3/login": { request: undefined; response: LoginFlowsResponse };
  "POST /v3/login": { request: LoginRequest; response: LoginResponse };
  "POST /v3/register": { request: RegisterRequest; response: RegisterResponse };
  "POST /v3/refresh": { request: RefreshRequest; response: RefreshResponse };
  "POST /v3/logout": { request: Record<string, never>; response: Record<string, never> };
  "GET /v3/account/whoami": { request: undefined; response: WhoamiResponse };
  "GET /v3/sync": { request: undefined; response: SyncResponse };
  "POST /v3/createRoom": { request: CreateRoomRequest; response: CreateRoomResponse };
  "POST /v3/join/:roomIdOrAlias": { request: JoinRequest; response: JoinResponse };
  "POST /v3/rooms/:roomId/leave": { request: LeaveRequest; response: Record<string, never> };
  "POST /v3/rooms/:roomId/forget": { request: Record<string, never>; response: Record<string, never> };
  "POST /v3/rooms/:roomId/invite": { request: MembershipRequest; response: Record<string, never> };
  "POST /v3/rooms/:roomId/kick": { request: MembershipRequest; response: Record<string, never> };
  "POST /v3/rooms/:roomId/ban": { request: MembershipRequest; response: Record<string, never> };
  "POST /v3/rooms/:roomId/unban": { request: MembershipRequest; response: Record<string, never> };
  "PUT /v3/rooms/:roomId/send/:eventType/:txnId": { request: Record<string, unknown>; response: SendEventResponse | DelayedEventResponse };
  "PUT /v3/rooms/:roomId/state/:eventType/:stateKey": { request: Record<string, unknown>; response: SendEventResponse };
  "GET /v3/rooms/:roomId/state/:eventType/:stateKey": { request: undefined; response: Record<string, unknown> };
  "PUT /v3/rooms/:roomId/redact/:eventId/:txnId": { request: RedactRequest; response: SendEventResponse };
  "GET /v3/rooms/:roomId/messages": { request: undefined; response: MessagesResponse };
  "GET /v3/rooms/:roomId/members": { request: undefined; response: MembersResponse };
  "POST /v3/rooms/:roomId/receipt/:receiptType/:eventId": { request: ReceiptRequest; response: Record<string, never> };
  "PUT /v3/rooms/:roomId/typing/:userId": { request: TypingRequest; response: Record<string, never> };
  "GET /v3/profile/:userId": { request: undefined; response: ProfileResponse };
  "PUT /v3/profile/:userId/displayname": { request: SetDisplayNameRequest; response: Record<string, never> };
  "PUT /v3/user/:userId/account_data/:type": { request: Record<string, unknown>; response: Record<string, never> };
  "POST /v3/keys/upload": { request: KeysUploadRequest; response: KeysUploadResponse };
  "POST /v3/keys/query": { request: KeysQueryRequest; response: KeysQueryResponse };
  "POST /v3/keys/claim": { request: KeysClaimRequest; response: KeysClaimResponse };
  "PUT /v3/sendToDevice/:eventType/:txnId": { request: SendToDeviceRequest; response: Record<string, never> };
}

export type ClientEndpoint = keyof ClientEndpoints;
export type EndpointRequest<K extends ClientEndpoint> = ClientEndpoints[K]["request"];
export type EndpointResponse<K extends ClientEndpoint> = ClientEndpoints[K]["response"];

/** The `:name` parameters of an endpoint's path, as an object type. */
export type EndpointParams<K extends string> = K extends `${string}:${infer Name}/${infer Rest}`
  ? { [P in Name]: string } & EndpointParams<`/${Rest}`>
  : K extends `${string}:${infer Name}`
    ? { [P in Name]: string }
    : {};

/** "/v3/rooms/:roomId/leave" with { roomId } → "/v3/rooms/!a%3Ab/leave". Each value is one path segment. */
export function endpointPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
}
