export { createHomeserver, Homeserver, type HomeserverOptions, type Logger } from "#homeserver.ts";
export {
  getNodeHandler,
  getExpressHandler,
  getFastifyPlugin,
  getHonoHandler,
  getFetchHandler,
  isMatrixPath,
  type NodeHandler,
} from "#http/adapters.ts";
export { handleRequest } from "#http/handler.ts";
export { MatrixError } from "#core/errors.ts";
export { M, UNSTABLE } from "#core/m.ts";

// Database adapters
export type { DatabaseAdapter, Schema, ModelDef, FieldDef, WhereClause, Row, FindManyOptions, Operator } from "#storage/types.ts";
export { memoryAdapter } from "#storage/memory.ts";
export {
  sqlAdapter,
  sqliteAdapter,
  postgresAdapter,
  mysqlAdapter,
  type SqlAdapterOptions,
  type SqlDialect,
  type SqlExecutor,
  type SqliteDatabaseLike,
  type PgPoolLike,
  type MysqlPoolLike,
} from "#storage/sql.ts";
export { schema } from "#storage/schema.ts";

// Auth & media adapters
export type { UserAuthAdapter, PasswordCheckContext } from "#adapters/auth.ts";
export {
  memoryMedia,
  filesystemMedia,
  sharpThumbnailer,
  type MediaAdapter,
  type MediaMetadata,
  type Thumbnailer,
  type ThumbnailRequest,
} from "#adapters/media.ts";
export { s3Media, type S3MediaOptions } from "#adapters/s3.ts";
export type { ThreepidOptions, ThreepidEmail, ThreepidSms, ThreepidPurpose } from "#core/threepid.ts";
export { memoryRateLimiter, type RateLimiter, type RateLimitRule, type RateLimitAction } from "#core/ratelimit.ts";
export type { AdminService, ServerNoticesOptions } from "#core/admin.ts";

// Horizontal scaling
export { localCluster, postgresCluster, type ClusterAdapter, type PgClusterPoolLike } from "#adapters/cluster.ts";

// Federation, auth and admin
export type { FederationOptions } from "#federation/index.ts";
export { cloudflareTurn, type RtcOptions, type TurnCredentials, type TurnOptions } from "#api/rtc.ts";
export type { DelayedEventsOptions } from "#core/delayed.ts";
export type { OAuthDelegationOptions } from "#core/oauth.ts";
export type { OAuthServerOptions } from "#core/oauthserver.ts";
export { githubProvider, type SsoOptions, type SsoProvider } from "#core/sso.ts";
export type { AuditOptions, AuditAction, AuditEntry } from "#core/audit.ts";
export type { AdminRoomOptions } from "#core/adminroom.ts";
export { loadAppServiceRegistrations, parseAppServiceRegistration, type AppServiceRegistration } from "#core/appservices.ts";
