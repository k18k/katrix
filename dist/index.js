// The client
export { MatrixClient } from "./client.js";
// Authentication
export { Auth, CredentialsTokenProvider } from "./auth/login.js";
export { completeAuthorization, createAuthorizationRequest, getAuthMetadata, refreshOAuthToken, registerClient, } from "./auth/oauth.js";
// Models
export { MatrixEvent, redactContent, } from "./models/event.js";
export { Room } from "./models/room.js";
export { RoomState } from "./models/room-state.js";
export { Timeline } from "./models/timeline.js";
// Sync
export { SyncV3Transport, parseV3 } from "./sync/v3.js";
// Adapters: HTTP, storage
export { fetchHttpAdapter } from "./http/adapter.js";
export { MatrixHttpApi } from "./http/api.js";
export { ConnectionError, MatrixError } from "./http/errors.js";
export { STORES } from "./storage/adapter.js";
export { MemoryStorage, memoryStorage } from "./storage/memory.js";
export { Store, Transaction } from "./storage/store.js";
// Crypto: primitives (level 1), protocol (level 2), the client's E2EE engine
export { CryptoPrimitiveError } from "./crypto/primitives.js";
export { nobleCryptoPrimitives } from "./crypto/noble.js";
export { ProtocolError, } from "./protocol/protocol.js";
export { nativeE2EEProtocol } from "./protocol/native.js";
export { E2EEEngine } from "./e2ee/engine.js";
// Utilities
export { canonicalJson, signingJson } from "./util/canonical-json.js";
export { decodeBase64, encodeBase64 } from "./util/base64.js";
export { TypedEmitter } from "./util/emitter.js";
export { consoleLogger, noopLogger } from "./util/logger.js";
