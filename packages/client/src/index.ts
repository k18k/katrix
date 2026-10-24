// The client
export { MatrixClient, type ClientEvents, type ClientOptions, type SyncState, type TimelineEventInfo } from "./client.ts";

// Authentication
export { Auth, CredentialsTokenProvider, type LoginOptions, type UserIdentifier } from "./auth/login.ts";
export type { Credentials, CredentialsStore, TokenProvider } from "./auth/types.ts";
export {
  completeAuthorization,
  createAuthorizationRequest,
  getAuthMetadata,
  refreshOAuthToken,
  registerClient,
  type AuthMetadata,
  type AuthorizationRequest,
  type OAuthTokens,
} from "./auth/oauth.ts";

// Models
export {
  MatrixEvent,
  redactContent,
  type DecryptionFailureCode,
  type DecryptionInfo,
  type DecryptionStatus,
  type LocalEchoStatus,
} from "./models/event.ts";
export { Room, type Receipt, type RoomSummary } from "./models/room.ts";
export { RoomState, type RoomMember } from "./models/room-state.ts";
export { Timeline } from "./models/timeline.ts";
export type * from "./models/types.ts";

// Sync
export { SyncV3Transport, parseV3, type V3SyncOptions } from "./sync/v3.ts";
export type {
  InvitedRoomUpdate,
  JoinedRoomUpdate,
  LeftRoomUpdate,
  SyncRequest,
  SyncResult,
  SyncTransport,
  TimelineUpdate,
} from "./sync/types.ts";

// Adapters: HTTP, storage
export { fetchHttpAdapter, type HttpAdapter, type HttpRequest, type HttpResponse } from "./http/adapter.ts";
export { MatrixHttpApi, type RequestOptions } from "./http/api.ts";
export { ConnectionError, MatrixError } from "./http/errors.ts";
export { STORES, type StorageAdapter, type StoreName, type WriteOp } from "./storage/adapter.ts";
export { MemoryStorage, memoryStorage } from "./storage/memory.ts";
export { Store, Transaction } from "./storage/store.ts";

// Crypto: primitives (level 1), protocol (level 2), the client's E2EE engine
export { CryptoPrimitiveError, type CryptoPrimitives, type KeyPair } from "./crypto/primitives.ts";
export { nobleCryptoPrimitives } from "./crypto/noble.ts";
export {
  ProtocolError,
  type E2EEProtocol,
  type IdentityKeys,
  type InboundGroupSession,
  type OlmAccount,
  type OlmMessage,
  type OlmSession,
  type OutboundGroupSession,
  type PickleKey,
  type ProtocolErrorCode,
  type SessionOrdering,
} from "./protocol/protocol.ts";
export { nativeE2EEProtocol } from "./protocol/native.ts";
export { E2EEEngine, type ToDeviceOutcome } from "./e2ee/engine.ts";
export type { DeviceInfo } from "./e2ee/crypto-store.ts";
export type { DecryptedToDevice } from "./e2ee/olm.ts";
export type { RoomEncryptionInfo } from "./e2ee/megolm.ts";

// Utilities
export { canonicalJson, signingJson } from "./util/canonical-json.ts";
export { decodeBase64, encodeBase64 } from "./util/base64.ts";
export { TypedEmitter } from "./util/emitter.ts";
export { consoleLogger, noopLogger, type Logger } from "./util/logger.ts";
