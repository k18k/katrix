// The client
export { MatrixClient, type ClientEvents, type ClientOptions, type SyncState, type TimelineEventInfo } from "./client.ts";

// Authentication
export { Auth, CredentialsTokenProvider, type LoginOptions } from "./auth/login.ts";
export type { Credentials, CredentialsStore, TokenProvider } from "./auth/types.ts";
export { dummyAuth, nextStage, passwordAuth, withUserInteractiveAuth, type UiaCallback, type UiaSession } from "./auth/uia.ts";
export {
  completeAuthorization,
  createAuthorizationRequest,
  getAuthMetadata,
  refreshOAuthToken,
  registerClient,
  type AuthorizationRequest,
  type OAuthTokens,
} from "./auth/oauth.ts";

// Account, profile, directory, administration
export { AccountApi } from "./account/account.ts";
export { AdminApi } from "./account/admin.ts";
export { DevicesApi } from "./account/devices.ts";
export { PresenceApi, ProfileApi } from "./account/profile.ts";
export { DirectoryApi } from "./directory/directory.ts";

// Media
export { MediaApi, parseMxc } from "./media/media.ts";
export { AttachmentError, decryptAttachment, encryptAttachment } from "./media/attachments.ts";

// Spaces
export { SpacesApi, type SpaceChild } from "./spaces/spaces.ts";

// Push
export { PushApi, type PushOutcome } from "./push/push.ts";

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
export { isValidReplacement, Relations, relationOf, type ReactionGroup, type ThreadSummary } from "./models/relations.ts";
export { RoomState, type RoomMember } from "./models/room-state.ts";
export { Timeline } from "./models/timeline.ts";
export type * from "@katrix/shared/types";

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
export { CrossSigning, type CrossSigningPrivateKeys, type DeviceTrust, type UserTrust } from "./e2ee/cross-signing.ts";
export {
  decodeRecoveryKey,
  encodeRecoveryKey,
  SecretStorage,
  SecretStorageError,
  type AccountDataAccess,
  type SecretStorageKeyDescription,
} from "./e2ee/secret-storage.ts";
export { decryptBackupSession, encryptBackupSession, KeyBackup, type BackedUpSession } from "./e2ee/backup.ts";
export { KeySharing, type SecretProvider } from "./e2ee/sharing.ts";
export { Recovery, SECRET_NAMES } from "./e2ee/recovery.ts";
export { VerificationManager, type VerificationManagerEvents } from "./e2ee/verification/manager.ts";
export {
  ALL_METHODS as VERIFICATION_METHODS,
  VerificationRequest,
  type SasCode,
  type VerificationChannel,
  type VerificationEvents,
  type VerificationPhase,
} from "./e2ee/verification/request.ts";
export { SAS_EMOJI } from "./e2ee/verification/sas.ts";
export { decodeQr, encodeQr, type QrData, type QrMode } from "./e2ee/verification/qr.ts";
export type { DeviceInfo } from "./e2ee/crypto-store.ts";
export type { DecryptedToDevice } from "./e2ee/olm.ts";
export type { RoomEncryptionInfo } from "./e2ee/megolm.ts";

// Utilities
export { canonicalJson, decodeBase64, encodeBase64, signingJson } from "@katrix/shared";
export { TypedEmitter } from "./util/emitter.ts";
export { consoleLogger, noopLogger, type Logger } from "./util/logger.ts";
