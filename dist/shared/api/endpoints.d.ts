import { AddThreePidRequest, AppservicePingRequest, AppservicePingResponse, BindThreePidRequest, CapabilitiesResponse, ChangePasswordRequest, CreateFilterResponse, DeactivateRequest, DeleteDeviceRequest, DeleteDevicesRequest, DeleteThreePidRequest, Device, DevicesResponse, EmailTokenRequest, Filter, LockBody, LoginTokenRequest, LoginTokenResponse, MsisdnTokenRequest, OpenIdToken, PresenceResponse, RequestTokenResponse, RoomInitialSyncResponse, SetPresenceRequest, SuspendBody, TagRequest, TagsResponse, ThreePidsResponse, TurnServerResponse, UnbindResultResponse, UpdateDeviceRequest, WhoisResponse } from "./account.js";
import { AuthMetadata, LoginFlowsResponse, LoginRequest, LoginResponse, RefreshRequest, RefreshResponse, RegisterRequest, RegisterResponse, RegistrationTokenValidityResponse, UsernameAvailableResponse, VersionsResponse, WellKnownClient, WellKnownSupport, WhoamiResponse } from "./auth.js";
import { BackupKeysUpdateResponse, BackupVersionRequest, BackupVersionResponse, CreateBackupVersionResponse, DeviceSigningUploadRequest, KeyBackupData, KeyChangesResponse, KeysBackup, KeysClaimRequest, KeysClaimResponse, KeysQueryRequest, KeysQueryResponse, KeysUploadRequest, KeysUploadResponse, RoomKeyBackup, SendToDeviceRequest, SignaturesUploadRequest, SignaturesUploadResponse } from "./keys.js";
import { CreateMediaResponse, MediaBody, MediaConfigResponse, UploadResponse, UrlPreviewResponse } from "./media.js";
import { PushRule, PushRuleActionsBody, PushRuleEnabledBody, PushRulesResponse, PushRuleset, PushersResponse, SetPushRuleRequest, SetPusherRequest } from "./push.js";
import { AliasResponse, ContextResponse, CreateRoomRequest, CreateRoomResponse, DelayedEventResponse, HierarchyResponse, JoinRequest, JoinResponse, JoinedMembersResponse, JoinedRoomsResponse, KnockRequest, LeaveRequest, MembersResponse, MembershipRequest, MessagesResponse, MutualRoomsResponse, NotificationsResponse, PeekEventsResponse, ProfileFieldBody, ProfileResponse, PublicRoomsRequest, PublicRoomsResponse, ReadMarkersRequest, ReceiptRequest, RedactRequest, RelationsResponse, ReportRequest, RoomAliasesResponse, RoomSummaryResponse, RoomVisibilityBody, SearchRequest, SearchResponse, SendEventResponse, SetAliasRequest, ThirdPartyInvite, ThirdPartyLocation, ThirdPartyProtocol, ThirdPartyUser, ThreadsResponse, TimestampToEventResponse, TypingRequest, UpgradeRoomRequest, UpgradeRoomResponse, UserDirectorySearchRequest, UserDirectorySearchResponse } from "./rooms.js";
import { SyncResponse } from "./sync.js";
import { ClientEvent } from "../events.js";
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
  "GET /.well-known/matrix/client": {
    request: undefined;
    response: WellKnownClient;
  };
  "GET /.well-known/matrix/support": {
    request: undefined;
    response: WellKnownSupport;
  };
  "GET /versions": {
    request: undefined;
    response: VersionsResponse;
  };
  "GET /v3/capabilities": {
    request: undefined;
    response: CapabilitiesResponse;
  };
  "GET /v1/auth_metadata": {
    request: undefined;
    response: AuthMetadata;
  };
  "GET /v3/login": {
    request: undefined;
    response: LoginFlowsResponse;
  };
  "POST /v3/login": {
    request: LoginRequest;
    response: LoginResponse;
  };
  "POST /v1/login/get_token": {
    request: LoginTokenRequest;
    response: LoginTokenResponse;
  };
  "POST /v3/register": {
    request: RegisterRequest;
    response: RegisterResponse;
  };
  "GET /v3/register/available": {
    request: undefined;
    response: UsernameAvailableResponse;
  };
  "POST /v3/register/email/requestToken": {
    request: EmailTokenRequest;
    response: RequestTokenResponse;
  };
  "POST /v3/register/msisdn/requestToken": {
    request: MsisdnTokenRequest;
    response: RequestTokenResponse;
  };
  "GET /v1/register/m.login.registration_token/validity": {
    request: undefined;
    response: RegistrationTokenValidityResponse;
  };
  "POST /v3/refresh": {
    request: RefreshRequest;
    response: RefreshResponse;
  };
  "POST /v3/logout": {
    request: Empty;
    response: Empty;
  };
  "POST /v3/logout/all": {
    request: Empty;
    response: Empty;
  };
  "GET /v3/account/whoami": {
    request: undefined;
    response: WhoamiResponse;
  };
  "POST /v3/account/password": {
    request: ChangePasswordRequest;
    response: Empty;
  };
  "POST /v3/account/password/email/requestToken": {
    request: EmailTokenRequest;
    response: RequestTokenResponse;
  };
  "POST /v3/account/password/msisdn/requestToken": {
    request: MsisdnTokenRequest;
    response: RequestTokenResponse;
  };
  "POST /v3/account/deactivate": {
    request: DeactivateRequest;
    response: UnbindResultResponse;
  };
  "GET /v3/account/3pid": {
    request: undefined;
    response: ThreePidsResponse;
  };
  "POST /v3/account/3pid/add": {
    request: AddThreePidRequest;
    response: Empty;
  };
  "POST /v3/account/3pid/bind": {
    request: BindThreePidRequest;
    response: Empty;
  };
  "POST /v3/account/3pid/delete": {
    request: DeleteThreePidRequest;
    response: UnbindResultResponse;
  };
  "POST /v3/account/3pid/unbind": {
    request: DeleteThreePidRequest;
    response: UnbindResultResponse;
  };
  "POST /v3/account/3pid/email/requestToken": {
    request: EmailTokenRequest;
    response: RequestTokenResponse;
  };
  "POST /v3/account/3pid/msisdn/requestToken": {
    request: MsisdnTokenRequest;
    response: RequestTokenResponse;
  };
  "POST /v3/user/:userId/openid/request_token": {
    request: Empty;
    response: OpenIdToken;
  };
  "GET /v3/devices": {
    request: undefined;
    response: DevicesResponse;
  };
  "GET /v3/devices/:deviceId": {
    request: undefined;
    response: Device;
  };
  "PUT /v3/devices/:deviceId": {
    request: UpdateDeviceRequest;
    response: Empty;
  };
  "DELETE /v3/devices/:deviceId": {
    request: DeleteDeviceRequest;
    response: Empty;
  };
  "POST /v3/delete_devices": {
    request: DeleteDevicesRequest;
    response: Empty;
  };
  "GET /v3/profile/:userId": {
    request: undefined;
    response: ProfileResponse;
  };
  "GET /v3/profile/:userId/:keyName": {
    request: undefined;
    response: ProfileFieldBody;
  };
  "PUT /v3/profile/:userId/:keyName": {
    request: ProfileFieldBody;
    response: Empty;
  };
  "DELETE /v3/profile/:userId/:keyName": {
    request: undefined;
    response: Empty;
  };
  "GET /v3/presence/:userId/status": {
    request: undefined;
    response: PresenceResponse;
  };
  "PUT /v3/presence/:userId/status": {
    request: SetPresenceRequest;
    response: Empty;
  };
  "GET /v3/user/:userId/account_data/:type": {
    request: undefined;
    response: Json;
  };
  "PUT /v3/user/:userId/account_data/:type": {
    request: Json;
    response: Empty;
  };
  "GET /v3/user/:userId/rooms/:roomId/account_data/:type": {
    request: undefined;
    response: Json;
  };
  "PUT /v3/user/:userId/rooms/:roomId/account_data/:type": {
    request: Json;
    response: Empty;
  };
  "GET /v3/user/:userId/rooms/:roomId/tags": {
    request: undefined;
    response: TagsResponse;
  };
  "PUT /v3/user/:userId/rooms/:roomId/tags/:tag": {
    request: TagRequest;
    response: Empty;
  };
  "DELETE /v3/user/:userId/rooms/:roomId/tags/:tag": {
    request: undefined;
    response: Empty;
  };
  "POST /v3/user/:userId/filter": {
    request: Filter;
    response: CreateFilterResponse;
  };
  "GET /v3/user/:userId/filter/:filterId": {
    request: undefined;
    response: Filter;
  };
  "GET /v3/sync": {
    request: undefined;
    response: SyncResponse;
  };
  "GET /v3/events": {
    request: undefined;
    response: PeekEventsResponse;
  };
  "POST /v3/createRoom": {
    request: CreateRoomRequest;
    response: CreateRoomResponse;
  };
  "GET /v3/joined_rooms": {
    request: undefined;
    response: JoinedRoomsResponse;
  };
  "POST /v3/join/:roomIdOrAlias": {
    request: JoinRequest;
    response: JoinResponse;
  };
  "POST /v3/rooms/:roomId/join": {
    request: JoinRequest;
    response: JoinResponse;
  };
  "POST /v3/knock/:roomIdOrAlias": {
    request: KnockRequest;
    response: JoinResponse;
  };
  "POST /v3/rooms/:roomId/leave": {
    request: LeaveRequest;
    response: Empty;
  };
  "POST /v3/rooms/:roomId/forget": {
    request: Empty;
    response: Empty;
  };
  "POST /v3/rooms/:roomId/invite": {
    request: MembershipRequest | ThirdPartyInvite;
    response: Empty;
  };
  "POST /v3/rooms/:roomId/kick": {
    request: MembershipRequest;
    response: Empty;
  };
  "POST /v3/rooms/:roomId/ban": {
    request: MembershipRequest;
    response: Empty;
  };
  "POST /v3/rooms/:roomId/unban": {
    request: MembershipRequest;
    response: Empty;
  };
  "POST /v3/rooms/:roomId/upgrade": {
    request: UpgradeRoomRequest;
    response: UpgradeRoomResponse;
  };
  "GET /v1/mutual_rooms": {
    request: undefined;
    response: MutualRoomsResponse;
  };
  "GET /v1/room_summary/:roomIdOrAlias": {
    request: undefined;
    response: RoomSummaryResponse;
  };
  "PUT /v3/rooms/:roomId/send/:eventType/:txnId": {
    request: Json;
    response: SendEventResponse | DelayedEventResponse;
  };
  "PUT /v3/rooms/:roomId/state/:eventType/:stateKey": {
    request: Json;
    response: SendEventResponse;
  };
  "GET /v3/rooms/:roomId/state/:eventType/:stateKey": {
    request: undefined;
    response: Json;
  };
  "GET /v3/rooms/:roomId/state": {
    request: undefined;
    response: ClientEvent[];
  };
  "GET /v3/rooms/:roomId/event/:eventId": {
    request: undefined;
    response: ClientEvent;
  };
  "GET /v3/rooms/:roomId/context/:eventId": {
    request: undefined;
    response: ContextResponse;
  };
  "GET /v3/rooms/:roomId/initialSync": {
    request: undefined;
    response: RoomInitialSyncResponse;
  };
  "PUT /v3/rooms/:roomId/redact/:eventId/:txnId": {
    request: RedactRequest;
    response: SendEventResponse;
  };
  "GET /v3/rooms/:roomId/messages": {
    request: undefined;
    response: MessagesResponse;
  };
  "GET /v3/rooms/:roomId/members": {
    request: undefined;
    response: MembersResponse;
  };
  "GET /v3/rooms/:roomId/joined_members": {
    request: undefined;
    response: JoinedMembersResponse;
  };
  "GET /v1/rooms/:roomId/relations/:eventId": {
    request: undefined;
    response: RelationsResponse;
  };
  "GET /v1/rooms/:roomId/relations/:eventId/:relType": {
    request: undefined;
    response: RelationsResponse;
  };
  "GET /v1/rooms/:roomId/relations/:eventId/:relType/:eventType": {
    request: undefined;
    response: RelationsResponse;
  };
  "GET /v1/rooms/:roomId/threads": {
    request: undefined;
    response: ThreadsResponse;
  };
  "GET /v1/rooms/:roomId/timestamp_to_event": {
    request: undefined;
    response: TimestampToEventResponse;
  };
  "GET /v1/rooms/:roomId/hierarchy": {
    request: undefined;
    response: HierarchyResponse;
  };
  "POST /v3/rooms/:roomId/receipt/:receiptType/:eventId": {
    request: ReceiptRequest;
    response: Empty;
  };
  "POST /v3/rooms/:roomId/read_markers": {
    request: ReadMarkersRequest;
    response: Empty;
  };
  "PUT /v3/rooms/:roomId/typing/:userId": {
    request: TypingRequest;
    response: Empty;
  };
  "POST /v3/rooms/:roomId/report": {
    request: ReportRequest;
    response: Empty;
  };
  "POST /v3/rooms/:roomId/report/:eventId": {
    request: ReportRequest;
    response: Empty;
  };
  "POST /v3/users/:userId/report": {
    request: ReportRequest;
    response: Empty;
  };
  "GET /v3/directory/room/:roomAlias": {
    request: undefined;
    response: AliasResponse;
  };
  "PUT /v3/directory/room/:roomAlias": {
    request: SetAliasRequest;
    response: Empty;
  };
  "DELETE /v3/directory/room/:roomAlias": {
    request: undefined;
    response: Empty;
  };
  "GET /v3/rooms/:roomId/aliases": {
    request: undefined;
    response: RoomAliasesResponse;
  };
  "GET /v3/directory/list/room/:roomId": {
    request: undefined;
    response: RoomVisibilityBody;
  };
  "PUT /v3/directory/list/room/:roomId": {
    request: RoomVisibilityBody;
    response: Empty;
  };
  "PUT /v3/directory/list/appservice/:networkId/:roomId": {
    request: Required<RoomVisibilityBody>;
    response: Empty;
  };
  "GET /v3/publicRooms": {
    request: undefined;
    response: PublicRoomsResponse;
  };
  "POST /v3/publicRooms": {
    request: PublicRoomsRequest;
    response: PublicRoomsResponse;
  };
  "POST /v3/user_directory/search": {
    request: UserDirectorySearchRequest;
    response: UserDirectorySearchResponse;
  };
  "POST /v3/search": {
    request: SearchRequest;
    response: SearchResponse;
  };
  "GET /v3/notifications": {
    request: undefined;
    response: NotificationsResponse;
  };
  "GET /v3/thirdparty/protocols": {
    request: undefined;
    response: Record<string, ThirdPartyProtocol>;
  };
  "GET /v3/thirdparty/protocol/:protocol": {
    request: undefined;
    response: ThirdPartyProtocol;
  };
  "GET /v3/thirdparty/location/:protocol": {
    request: undefined;
    response: ThirdPartyLocation[];
  };
  "GET /v3/thirdparty/user/:protocol": {
    request: undefined;
    response: ThirdPartyUser[];
  };
  "GET /v3/thirdparty/location": {
    request: undefined;
    response: ThirdPartyLocation[];
  };
  "GET /v3/thirdparty/user": {
    request: undefined;
    response: ThirdPartyUser[];
  };
  "POST /_matrix/media/v3/upload": {
    request: MediaBody;
    response: UploadResponse;
  };
  "PUT /_matrix/media/v3/upload/:serverName/:mediaId": {
    request: MediaBody;
    response: Empty;
  };
  "POST /_matrix/media/v1/create": {
    request: undefined;
    response: CreateMediaResponse;
  };
  "GET /v1/media/download/:serverName/:mediaId": {
    request: undefined;
    response: MediaBody;
  };
  "GET /v1/media/download/:serverName/:mediaId/:fileName": {
    request: undefined;
    response: MediaBody;
  };
  "GET /v1/media/thumbnail/:serverName/:mediaId": {
    request: undefined;
    response: MediaBody;
  };
  "GET /v1/media/preview_url": {
    request: undefined;
    response: UrlPreviewResponse;
  };
  "GET /v1/media/config": {
    request: undefined;
    response: MediaConfigResponse;
  };
  "GET /v3/pushers": {
    request: undefined;
    response: PushersResponse;
  };
  "POST /v3/pushers/set": {
    request: SetPusherRequest;
    response: Empty;
  };
  "GET /v3/pushrules/": {
    request: undefined;
    response: PushRulesResponse;
  };
  "GET /v3/pushrules/global/": {
    request: undefined;
    response: PushRuleset;
  };
  "GET /v3/pushrules/global/:kind/:ruleId": {
    request: undefined;
    response: PushRule;
  };
  "PUT /v3/pushrules/global/:kind/:ruleId": {
    request: SetPushRuleRequest;
    response: Empty;
  };
  "DELETE /v3/pushrules/global/:kind/:ruleId": {
    request: undefined;
    response: Empty;
  };
  "GET /v3/pushrules/global/:kind/:ruleId/enabled": {
    request: undefined;
    response: PushRuleEnabledBody;
  };
  "PUT /v3/pushrules/global/:kind/:ruleId/enabled": {
    request: PushRuleEnabledBody;
    response: Empty;
  };
  "GET /v3/pushrules/global/:kind/:ruleId/actions": {
    request: undefined;
    response: PushRuleActionsBody;
  };
  "PUT /v3/pushrules/global/:kind/:ruleId/actions": {
    request: PushRuleActionsBody;
    response: Empty;
  };
  "POST /v3/keys/upload": {
    request: KeysUploadRequest;
    response: KeysUploadResponse;
  };
  "POST /v3/keys/query": {
    request: KeysQueryRequest;
    response: KeysQueryResponse;
  };
  "POST /v3/keys/claim": {
    request: KeysClaimRequest;
    response: KeysClaimResponse;
  };
  "GET /v3/keys/changes": {
    request: undefined;
    response: KeyChangesResponse;
  };
  "POST /v3/keys/device_signing/upload": {
    request: DeviceSigningUploadRequest;
    response: Empty;
  };
  "POST /v3/keys/signatures/upload": {
    request: SignaturesUploadRequest;
    response: SignaturesUploadResponse;
  };
  "PUT /v3/sendToDevice/:eventType/:txnId": {
    request: SendToDeviceRequest;
    response: Empty;
  };
  "POST /v3/room_keys/version": {
    request: BackupVersionRequest;
    response: CreateBackupVersionResponse;
  };
  "GET /v3/room_keys/version": {
    request: undefined;
    response: BackupVersionResponse;
  };
  "GET /v3/room_keys/version/:version": {
    request: undefined;
    response: BackupVersionResponse;
  };
  "PUT /v3/room_keys/version/:version": {
    request: BackupVersionRequest;
    response: Empty;
  };
  "DELETE /v3/room_keys/version/:version": {
    request: undefined;
    response: Empty;
  };
  "PUT /v3/room_keys/keys": {
    request: KeysBackup;
    response: BackupKeysUpdateResponse;
  };
  "GET /v3/room_keys/keys": {
    request: undefined;
    response: KeysBackup;
  };
  "DELETE /v3/room_keys/keys": {
    request: undefined;
    response: BackupKeysUpdateResponse;
  };
  "PUT /v3/room_keys/keys/:roomId": {
    request: RoomKeyBackup;
    response: BackupKeysUpdateResponse;
  };
  "GET /v3/room_keys/keys/:roomId": {
    request: undefined;
    response: RoomKeyBackup;
  };
  "DELETE /v3/room_keys/keys/:roomId": {
    request: undefined;
    response: BackupKeysUpdateResponse;
  };
  "PUT /v3/room_keys/keys/:roomId/:sessionId": {
    request: KeyBackupData;
    response: BackupKeysUpdateResponse;
  };
  "GET /v3/room_keys/keys/:roomId/:sessionId": {
    request: undefined;
    response: KeyBackupData;
  };
  "DELETE /v3/room_keys/keys/:roomId/:sessionId": {
    request: undefined;
    response: BackupKeysUpdateResponse;
  };
  "GET /v3/voip/turnServer": {
    request: undefined;
    response: TurnServerResponse;
  };
  "GET /v3/admin/whois/:userId": {
    request: undefined;
    response: WhoisResponse;
  };
  "GET /v1/admin/suspend/:userId": {
    request: undefined;
    response: SuspendBody;
  };
  "PUT /v1/admin/suspend/:userId": {
    request: SuspendBody;
    response: SuspendBody;
  };
  "GET /v1/admin/lock/:userId": {
    request: undefined;
    response: LockBody;
  };
  "PUT /v1/admin/lock/:userId": {
    request: LockBody;
    response: LockBody;
  };
  "POST /v1/appservice/:appserviceId/ping": {
    request: AppservicePingRequest;
    response: AppservicePingResponse;
  };
}
export type ClientEndpoint = keyof ClientEndpoints;
export type EndpointRequest<K extends ClientEndpoint> = ClientEndpoints[K]["request"];
export type EndpointResponse<K extends ClientEndpoint> = ClientEndpoints[K]["response"];
/** The `:name` parameters of an endpoint's path, as an object type. */
export type EndpointParams<K extends string> = K extends `${string}:${infer Name}/${infer Rest}` ? { [P in Name]: string; } & EndpointParams<`/${Rest}`> : K extends `${string}:${infer Name}` ? { [P in Name]: string; } : {};
/** The absolute path of an endpoint's path template: under /_matrix/client unless it is absolute already. */
export declare function endpointUrlPath(template: string): string;
/** "/v3/rooms/:roomId/leave" with { roomId } → "/v3/rooms/!a%3Ab/leave". Each value is one path segment. */
export declare function endpointPath(template: string, params: Record<string, string>): string;
export {};
//# sourceMappingURL=endpoints.d.ts.map