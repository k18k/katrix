import type * as A from "./account.ts";
import type * as Au from "./auth.ts";
import type * as K from "./keys.ts";
import type * as Md from "./media.ts";
import type * as P from "./push.ts";
import type * as R from "./rooms.ts";
import type { SyncResponse } from "./sync.ts";
import type { ClientEvent } from "../events.ts";

type Empty = Record<string, never>;
type Json = Record<string, unknown>;

/**
 * The Client-Server API (Matrix v1.19), by `"METHOD /path"`: what the request body is and what
 * the response is. The client builds its requests from this map (MatrixHttpApi.endpoint), and the
 * server checks its responses against it, so the two cannot drift apart.
 *
 * Paths are under /_matrix/client, except those that start with /_matrix/ (the media API under
 * /_matrix/media) or /.well-known/, which are absolute (endpointUrlPath). `:name` marks a path
 * parameter. `request: undefined` means no body, and a `MediaBody` request or response is bytes
 * rather than JSON. Query parameters are not part of the map.
 *
 * Every stable endpoint is here except the deprecated ones (GET /v3/initialSync, GET
 * /v3/events/{eventId}, POST /v3/account/3pid, the unauthenticated /_matrix/media/v3 downloads),
 * the policy server's /.well-known/matrix/policy_server, which clients do not call, and the SSO
 * redirects (GET /v3/login/sso/redirect[/{idpId}]), which are browser navigations rather than
 * API calls: the client builds their URLs.
 */
export interface ClientEndpoints {
  // Discovery, versions, capabilities
  "GET /.well-known/matrix/client": { request: undefined; response: Au.WellKnownClient };
  "GET /.well-known/matrix/support": { request: undefined; response: Au.WellKnownSupport };
  "GET /versions": { request: undefined; response: Au.VersionsResponse };
  "GET /v3/capabilities": { request: undefined; response: A.CapabilitiesResponse };
  "GET /v1/auth_metadata": { request: undefined; response: Au.AuthMetadata };

  // Login, registration, the session
  "GET /v3/login": { request: undefined; response: Au.LoginFlowsResponse };
  "POST /v3/login": { request: Au.LoginRequest; response: Au.LoginResponse };
  "POST /v1/login/get_token": { request: A.LoginTokenRequest; response: A.LoginTokenResponse };
  "POST /v3/register": { request: Au.RegisterRequest; response: Au.RegisterResponse };
  "GET /v3/register/available": { request: undefined; response: Au.UsernameAvailableResponse };
  "POST /v3/register/email/requestToken": { request: A.EmailTokenRequest; response: A.RequestTokenResponse };
  "POST /v3/register/msisdn/requestToken": { request: A.MsisdnTokenRequest; response: A.RequestTokenResponse };
  "GET /v1/register/m.login.registration_token/validity": { request: undefined; response: Au.RegistrationTokenValidityResponse };
  "POST /v3/refresh": { request: Au.RefreshRequest; response: Au.RefreshResponse };
  "POST /v3/logout": { request: Empty; response: Empty };
  "POST /v3/logout/all": { request: Empty; response: Empty };
  "GET /v3/account/whoami": { request: undefined; response: Au.WhoamiResponse };

  // Account management
  "POST /v3/account/password": { request: A.ChangePasswordRequest; response: Empty };
  "POST /v3/account/password/email/requestToken": { request: A.EmailTokenRequest; response: A.RequestTokenResponse };
  "POST /v3/account/password/msisdn/requestToken": { request: A.MsisdnTokenRequest; response: A.RequestTokenResponse };
  "POST /v3/account/deactivate": { request: A.DeactivateRequest; response: A.UnbindResultResponse };
  "GET /v3/account/3pid": { request: undefined; response: A.ThreePidsResponse };
  "POST /v3/account/3pid/add": { request: A.AddThreePidRequest; response: Empty };
  "POST /v3/account/3pid/bind": { request: A.BindThreePidRequest; response: Empty };
  "POST /v3/account/3pid/delete": { request: A.DeleteThreePidRequest; response: A.UnbindResultResponse };
  "POST /v3/account/3pid/unbind": { request: A.DeleteThreePidRequest; response: A.UnbindResultResponse };
  "POST /v3/account/3pid/email/requestToken": { request: A.EmailTokenRequest; response: A.RequestTokenResponse };
  "POST /v3/account/3pid/msisdn/requestToken": { request: A.MsisdnTokenRequest; response: A.RequestTokenResponse };
  "POST /v3/user/:userId/openid/request_token": { request: Empty; response: A.OpenIdToken };

  // Devices
  "GET /v3/devices": { request: undefined; response: A.DevicesResponse };
  "GET /v3/devices/:deviceId": { request: undefined; response: A.Device };
  "PUT /v3/devices/:deviceId": { request: A.UpdateDeviceRequest; response: Empty };
  "DELETE /v3/devices/:deviceId": { request: A.DeleteDeviceRequest; response: Empty };
  "POST /v3/delete_devices": { request: A.DeleteDevicesRequest; response: Empty };

  // Profile, presence, account data, tags, filters
  "GET /v3/profile/:userId": { request: undefined; response: R.ProfileResponse };
  "GET /v3/profile/:userId/:keyName": { request: undefined; response: R.ProfileFieldBody };
  "PUT /v3/profile/:userId/:keyName": { request: R.ProfileFieldBody; response: Empty };
  "DELETE /v3/profile/:userId/:keyName": { request: undefined; response: Empty };
  "GET /v3/presence/:userId/status": { request: undefined; response: A.PresenceResponse };
  "PUT /v3/presence/:userId/status": { request: A.SetPresenceRequest; response: Empty };
  "GET /v3/user/:userId/account_data/:type": { request: undefined; response: Json };
  "PUT /v3/user/:userId/account_data/:type": { request: Json; response: Empty };
  "GET /v3/user/:userId/rooms/:roomId/account_data/:type": { request: undefined; response: Json };
  "PUT /v3/user/:userId/rooms/:roomId/account_data/:type": { request: Json; response: Empty };
  "GET /v3/user/:userId/rooms/:roomId/tags": { request: undefined; response: A.TagsResponse };
  "PUT /v3/user/:userId/rooms/:roomId/tags/:tag": { request: A.TagRequest; response: Empty };
  "DELETE /v3/user/:userId/rooms/:roomId/tags/:tag": { request: undefined; response: Empty };
  "POST /v3/user/:userId/filter": { request: A.Filter; response: A.CreateFilterResponse };
  "GET /v3/user/:userId/filter/:filterId": { request: undefined; response: A.Filter };

  // Sync
  "GET /v3/sync": { request: undefined; response: SyncResponse };
  "GET /v3/events": { request: undefined; response: R.PeekEventsResponse };

  // Rooms: creation, membership
  "POST /v3/createRoom": { request: R.CreateRoomRequest; response: R.CreateRoomResponse };
  "GET /v3/joined_rooms": { request: undefined; response: R.JoinedRoomsResponse };
  "POST /v3/join/:roomIdOrAlias": { request: R.JoinRequest; response: R.JoinResponse };
  "POST /v3/rooms/:roomId/join": { request: R.JoinRequest; response: R.JoinResponse };
  "POST /v3/knock/:roomIdOrAlias": { request: R.KnockRequest; response: R.JoinResponse };
  "POST /v3/rooms/:roomId/leave": { request: R.LeaveRequest; response: Empty };
  "POST /v3/rooms/:roomId/forget": { request: Empty; response: Empty };
  "POST /v3/rooms/:roomId/invite": { request: R.MembershipRequest | R.ThirdPartyInvite; response: Empty };
  "POST /v3/rooms/:roomId/kick": { request: R.MembershipRequest; response: Empty };
  "POST /v3/rooms/:roomId/ban": { request: R.MembershipRequest; response: Empty };
  "POST /v3/rooms/:roomId/unban": { request: R.MembershipRequest; response: Empty };
  "POST /v3/rooms/:roomId/upgrade": { request: R.UpgradeRoomRequest; response: R.UpgradeRoomResponse };
  "GET /v1/mutual_rooms": { request: undefined; response: R.MutualRoomsResponse };
  "GET /v1/room_summary/:roomIdOrAlias": { request: undefined; response: R.RoomSummaryResponse };

  // Rooms: events and state
  "PUT /v3/rooms/:roomId/send/:eventType/:txnId": { request: Json; response: R.SendEventResponse | R.DelayedEventResponse };
  "PUT /v3/rooms/:roomId/state/:eventType/:stateKey": { request: Json; response: R.SendEventResponse };
  "GET /v3/rooms/:roomId/state/:eventType/:stateKey": { request: undefined; response: Json };
  "GET /v3/rooms/:roomId/state": { request: undefined; response: ClientEvent[] };
  "GET /v3/rooms/:roomId/event/:eventId": { request: undefined; response: ClientEvent };
  "GET /v3/rooms/:roomId/context/:eventId": { request: undefined; response: R.ContextResponse };
  "GET /v3/rooms/:roomId/initialSync": { request: undefined; response: A.RoomInitialSyncResponse };
  "PUT /v3/rooms/:roomId/redact/:eventId/:txnId": { request: R.RedactRequest; response: R.SendEventResponse };
  "GET /v3/rooms/:roomId/messages": { request: undefined; response: R.MessagesResponse };
  "GET /v3/rooms/:roomId/members": { request: undefined; response: R.MembersResponse };
  "GET /v3/rooms/:roomId/joined_members": { request: undefined; response: R.JoinedMembersResponse };
  "GET /v1/rooms/:roomId/relations/:eventId": { request: undefined; response: R.RelationsResponse };
  "GET /v1/rooms/:roomId/relations/:eventId/:relType": { request: undefined; response: R.RelationsResponse };
  "GET /v1/rooms/:roomId/relations/:eventId/:relType/:eventType": { request: undefined; response: R.RelationsResponse };
  "GET /v1/rooms/:roomId/threads": { request: undefined; response: R.ThreadsResponse };
  "GET /v1/rooms/:roomId/timestamp_to_event": { request: undefined; response: R.TimestampToEventResponse };
  "GET /v1/rooms/:roomId/hierarchy": { request: undefined; response: R.HierarchyResponse };

  // Rooms: receipts, typing, read markers, reports
  "POST /v3/rooms/:roomId/receipt/:receiptType/:eventId": { request: R.ReceiptRequest; response: Empty };
  "POST /v3/rooms/:roomId/read_markers": { request: R.ReadMarkersRequest; response: Empty };
  "PUT /v3/rooms/:roomId/typing/:userId": { request: R.TypingRequest; response: Empty };
  "POST /v3/rooms/:roomId/report": { request: R.ReportRequest; response: Empty };
  "POST /v3/rooms/:roomId/report/:eventId": { request: R.ReportRequest; response: Empty };
  "POST /v3/users/:userId/report": { request: R.ReportRequest; response: Empty };

  // Directory, search, notifications, third-party networks
  "GET /v3/directory/room/:roomAlias": { request: undefined; response: R.AliasResponse };
  "PUT /v3/directory/room/:roomAlias": { request: R.SetAliasRequest; response: Empty };
  "DELETE /v3/directory/room/:roomAlias": { request: undefined; response: Empty };
  "GET /v3/rooms/:roomId/aliases": { request: undefined; response: R.RoomAliasesResponse };
  "GET /v3/directory/list/room/:roomId": { request: undefined; response: R.RoomVisibilityBody };
  "PUT /v3/directory/list/room/:roomId": { request: R.RoomVisibilityBody; response: Empty };
  "PUT /v3/directory/list/appservice/:networkId/:roomId": { request: Required<R.RoomVisibilityBody>; response: Empty };
  "GET /v3/publicRooms": { request: undefined; response: R.PublicRoomsResponse };
  "POST /v3/publicRooms": { request: R.PublicRoomsRequest; response: R.PublicRoomsResponse };
  "POST /v3/user_directory/search": { request: R.UserDirectorySearchRequest; response: R.UserDirectorySearchResponse };
  "POST /v3/search": { request: R.SearchRequest; response: R.SearchResponse };
  "GET /v3/notifications": { request: undefined; response: R.NotificationsResponse };
  "GET /v3/thirdparty/protocols": { request: undefined; response: Record<string, R.ThirdPartyProtocol> };
  "GET /v3/thirdparty/protocol/:protocol": { request: undefined; response: R.ThirdPartyProtocol };
  "GET /v3/thirdparty/location/:protocol": { request: undefined; response: R.ThirdPartyLocation[] };
  "GET /v3/thirdparty/user/:protocol": { request: undefined; response: R.ThirdPartyUser[] };
  "GET /v3/thirdparty/location": { request: undefined; response: R.ThirdPartyLocation[] };
  "GET /v3/thirdparty/user": { request: undefined; response: R.ThirdPartyUser[] };

  // Media
  "POST /_matrix/media/v3/upload": { request: Md.MediaBody; response: Md.UploadResponse };
  "PUT /_matrix/media/v3/upload/:serverName/:mediaId": { request: Md.MediaBody; response: Empty };
  "POST /_matrix/media/v1/create": { request: undefined; response: Md.CreateMediaResponse };
  "GET /v1/media/download/:serverName/:mediaId": { request: undefined; response: Md.MediaBody };
  "GET /v1/media/download/:serverName/:mediaId/:fileName": { request: undefined; response: Md.MediaBody };
  "GET /v1/media/thumbnail/:serverName/:mediaId": { request: undefined; response: Md.MediaBody };
  "GET /v1/media/preview_url": { request: undefined; response: Md.UrlPreviewResponse };
  "GET /v1/media/config": { request: undefined; response: Md.MediaConfigResponse };

  // Push
  "GET /v3/pushers": { request: undefined; response: P.PushersResponse };
  "POST /v3/pushers/set": { request: P.SetPusherRequest; response: Empty };
  "GET /v3/pushrules/": { request: undefined; response: P.PushRulesResponse };
  "GET /v3/pushrules/global/": { request: undefined; response: P.PushRuleset };
  "GET /v3/pushrules/global/:kind/:ruleId": { request: undefined; response: P.PushRule };
  "PUT /v3/pushrules/global/:kind/:ruleId": { request: P.SetPushRuleRequest; response: Empty };
  "DELETE /v3/pushrules/global/:kind/:ruleId": { request: undefined; response: Empty };
  "GET /v3/pushrules/global/:kind/:ruleId/enabled": { request: undefined; response: P.PushRuleEnabledBody };
  "PUT /v3/pushrules/global/:kind/:ruleId/enabled": { request: P.PushRuleEnabledBody; response: Empty };
  "GET /v3/pushrules/global/:kind/:ruleId/actions": { request: undefined; response: P.PushRuleActionsBody };
  "PUT /v3/pushrules/global/:kind/:ruleId/actions": { request: P.PushRuleActionsBody; response: Empty };

  // End-to-end encryption
  "POST /v3/keys/upload": { request: K.KeysUploadRequest; response: K.KeysUploadResponse };
  "POST /v3/keys/query": { request: K.KeysQueryRequest; response: K.KeysQueryResponse };
  "POST /v3/keys/claim": { request: K.KeysClaimRequest; response: K.KeysClaimResponse };
  "GET /v3/keys/changes": { request: undefined; response: K.KeyChangesResponse };
  "POST /v3/keys/device_signing/upload": { request: K.DeviceSigningUploadRequest; response: Empty };
  "POST /v3/keys/signatures/upload": { request: K.SignaturesUploadRequest; response: K.SignaturesUploadResponse };
  "PUT /v3/sendToDevice/:eventType/:txnId": { request: K.SendToDeviceRequest; response: Empty };
  "POST /v3/room_keys/version": { request: K.BackupVersionRequest; response: K.CreateBackupVersionResponse };
  "GET /v3/room_keys/version": { request: undefined; response: K.BackupVersionResponse };
  "GET /v3/room_keys/version/:version": { request: undefined; response: K.BackupVersionResponse };
  "PUT /v3/room_keys/version/:version": { request: K.BackupVersionRequest; response: Empty };
  "DELETE /v3/room_keys/version/:version": { request: undefined; response: Empty };
  "PUT /v3/room_keys/keys": { request: K.KeysBackup; response: K.BackupKeysUpdateResponse };
  "GET /v3/room_keys/keys": { request: undefined; response: K.KeysBackup };
  "DELETE /v3/room_keys/keys": { request: undefined; response: K.BackupKeysUpdateResponse };
  "PUT /v3/room_keys/keys/:roomId": { request: K.RoomKeyBackup; response: K.BackupKeysUpdateResponse };
  "GET /v3/room_keys/keys/:roomId": { request: undefined; response: K.RoomKeyBackup };
  "DELETE /v3/room_keys/keys/:roomId": { request: undefined; response: K.BackupKeysUpdateResponse };
  "PUT /v3/room_keys/keys/:roomId/:sessionId": { request: K.KeyBackupData; response: K.BackupKeysUpdateResponse };
  "GET /v3/room_keys/keys/:roomId/:sessionId": { request: undefined; response: K.KeyBackupData };
  "DELETE /v3/room_keys/keys/:roomId/:sessionId": { request: undefined; response: K.BackupKeysUpdateResponse };

  // VoIP
  "GET /v3/voip/turnServer": { request: undefined; response: A.TurnServerResponse };

  // Administration, application services
  "GET /v3/admin/whois/:userId": { request: undefined; response: A.WhoisResponse };
  "GET /v1/admin/suspend/:userId": { request: undefined; response: A.SuspendBody };
  "PUT /v1/admin/suspend/:userId": { request: A.SuspendBody; response: A.SuspendBody };
  "GET /v1/admin/lock/:userId": { request: undefined; response: A.LockBody };
  "PUT /v1/admin/lock/:userId": { request: A.LockBody; response: A.LockBody };
  "POST /v1/appservice/:appserviceId/ping": { request: A.AppservicePingRequest; response: A.AppservicePingResponse };
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

/** The absolute path of an endpoint's path template: under /_matrix/client unless it is absolute already. */
export function endpointUrlPath(template: string): string {
  return template.startsWith("/_matrix/") || template.startsWith("/.well-known/") ? template : `/_matrix/client${template}`;
}

/** "/v3/rooms/:roomId/leave" with { roomId } → "/v3/rooms/!a%3Ab/leave". Each value is one path segment. */
export function endpointPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
}
