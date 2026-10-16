import { PartialStateService } from "./core/partialstate.ts";
import { PolicyServers } from "./core/policy.ts";
import { ThreepidService, type ThreepidOptions } from "./core/threepid.ts";
import { IdentityServers } from "./core/identity.ts";
import { EventEmitter } from "node:events";
import { AuthService } from "./core/auth.ts";
import { loadSigningKey, randomString, type SigningKey } from "./core/crypto.ts";
import { DEFAULT_ROOM_VERSION, SUPPORTED_ROOM_VERSIONS } from "./core/events.ts";
import { KeyService } from "./core/keys.ts";
import { Notifier } from "./core/notifier.ts";
import { localCluster, newInstanceId, StreamManager, type ClusterAdapter } from "./core/cluster.ts";
import { RoomService } from "./core/rooms.ts";
import { TypingService } from "./core/typing.ts";
import { PushService } from "./core/push.ts";
import { AdminService, type ServerNoticesOptions } from "./core/admin.ts";
import { OAuthDelegation, type OAuthDelegationOptions } from "./core/oauth.ts";
import { SsoService, type SsoOptions } from "./core/sso.ts";
import { FederationService, type FederationOptions } from "./federation/index.ts";
import { DelayedEventService, type DelayedEventsOptions } from "./core/delayed.ts";
import type { RtcOptions } from "./api/rtc.ts";
import { AuditService, type AuditOptions } from "./core/audit.ts";
import { SettingsService } from "./core/settings.ts";
import { AdminRoomService, type AdminRoomOptions } from "./core/adminroom.ts";
import { AppServiceService, type AppServiceRegistration } from "./core/appservices.ts";
import { memoryRateLimiter, RateLimits, type RateLimitAction, type RateLimiter, type RateLimitRule } from "./core/ratelimit.ts";
import { resolveUserAuth, type ResolvedUserAuth, type UserAuthAdapter } from "./adapters/auth.ts";
import { memoryMedia, type MediaAdapter, type Thumbnailer } from "./adapters/media.ts";
import { memoryAdapter } from "./storage/memory.ts";
import { schema } from "./storage/schema.ts";
import type { DatabaseAdapter } from "./storage/types.ts";
import { Router } from "./http/router.ts";
import { registerRoutes } from "./api/index.ts";

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface HomeserverOptions {
  /** The server name, i.e. the part after the colon in `@user:server`. */
  homeserver: string;
  /** Storage backend. Defaults to an in-memory database. */
  databaseAdapter?: DatabaseAdapter | Record<string, never>;
  /** Authentication customisation. Defaults to built-in password auth. */
  userAuthAdapter?: UserAuthAdapter;
  /** Media byte storage. Defaults to in-memory storage. */
  mediaAdapter?: MediaAdapter | Record<string, never>;
  /** Public URL of the client API, advertised via `/.well-known/matrix/client`. */
  publicBaseUrl?: string;
  /**
   * Federation address ("host" or "host:port") advertised at `/.well-known/matrix/server`, when
   * other servers should reach this server somewhere else than `<server name>:8448`.
   */
  federationAddress?: string;
  /** Contacts and page served at `/.well-known/matrix/support` (e.g. to appeal a locked account). */
  support?: {
    contacts?: { role: "m.role.admin" | "m.role.security" | (string & {}); matrix_id?: string; email_address?: string }[];
    supportPage?: string;
  };
  /**
   * Email addresses and phone numbers (3PIDs): how validation messages are sent, and whether
   * registration needs an email address. 3PID invites through identity servers work without it.
   */
  threepid?: ThreepidOptions;
  /**
   * Lets a logged-in client generate a one-time login token for a new device
   * (`POST /login/get_token`, after re-authentication). Default: true.
   */
  loginViaExistingSession?: boolean;
  /** Enables Synapse-compatible shared-secret registration at `/_synapse/admin/v1/register`. */
  registrationSharedSecret?: string;
  /** Persisted ed25519 signing key. Generated and stored in the database when omitted. */
  signingKey?: { keyId: string; seed: string };
  /** Room version used when clients do not ask for one. Default: "10". */
  defaultRoomVersion?: string;
  /** When set, clients requesting refresh tokens get access tokens that expire after this many ms. */
  accessTokenLifetimeMs?: number;
  /** Maximum `/sync` long-poll duration in ms. Default: 30000. */
  maxSyncTimeoutMs?: number;
  /**
   * Enables `/preview_url`. Off by default because it makes the server fetch arbitrary URLs.
   * Private/internal addresses stay blocked unless `allowPrivateAddresses` is set.
   */
  urlPreviews?: boolean | { allowPrivateAddresses?: boolean };
  logger?: Logger;
  /** Custom `fetch` for outgoing HTTP requests. */
  fetch?: typeof globalThis.fetch;
  /**
   * Rate limiting. `false` disables it; otherwise per-action overrides and an optional
   * shared limiter (defaults to an in-memory token bucket). Admins are never limited.
   */
  /** Delegate authentication to an external OAuth 2.0 / OIDC provider (disables password login and registration). */
  oauth?: OAuthDelegationOptions;
  /** Upstream OpenID Connect providers for `m.login.sso`. Requires `publicBaseUrl`. */
  sso?: SsoOptions;
  /**
   * Coordination between instances. The default (`localCluster()`) supports one process;
   * use `postgresCluster()` / `redisCluster()` to scale horizontally.
   */
  cluster?: ClusterAdapter;
  /**
   * Admin room with an admin bot (tuwunel-style); the first registered account becomes
   * a server admin. Pass `true` or options to enable. Default: disabled.
   */
  adminRoom?: boolean | AdminRoomOptions;
  /** Audit log of security-relevant actions. Default: disabled. */
  audit?: AuditOptions;
  /** Application service registrations (bridges, bots). */
  appservices?: AppServiceRegistration[];
  /** VoIP (TURN) and MatrixRTC configuration. */
  rtc?: RtcOptions;
  /** Delayed events (MSC4140) limits. */
  delayedEvents?: DelayedEventsOptions;
  /** Federation (server-server API). Enabled by default. */
  federation?: FederationOptions;
  /** Generates image thumbnails, e.g. `sharpThumbnailer(sharp)`. Without one, originals are served. */
  thumbnailer?: Thumbnailer;
  /** Server notices (system messages to users). */
  serverNotices?: ServerNoticesOptions;
  rateLimits?: false | { limiter?: RateLimiter; rules?: Partial<Record<RateLimitAction, RateLimitRule>> };
  /** Interval for background cleanup of expired data, in ms. Default: 10 minutes. `0` disables it. */
  cleanupIntervalMs?: number;
}

export interface ResolvedConfig {
  serverName: string;
  publicBaseUrl: string | null;
  federationAddress: string | null;
  support: { contacts: { role: string; matrix_id?: string; email_address?: string }[]; support_page?: string } | null;
  loginViaExistingSession: boolean;
  threepid: ThreepidOptions & { identityServerProtocol: "https" | "http" };
  registrationSharedSecret: string | null;
  defaultRoomVersion: string;
  accessTokenLifetimeMs: number | null;
  maxSyncTimeoutMs: number;
  urlPreviews: { allowPrivateAddresses: boolean } | null;
  serverNotices: Required<ServerNoticesOptions>;
  thumbnailer: Thumbnailer | null;
  rtc: RtcOptions;
}

const consoleLogger: Logger = {
  debug: () => {},
  info: (...a) => console.info("[matrix]", ...a),
  warn: (...a) => console.warn("[matrix]", ...a),
  error: (...a) => console.error("[matrix]", ...a),
};

const STREAM_TABLES: [string, string][] = [
  ["events", "stream"],
  ["account_data", "stream"],
  ["receipts", "stream"],
  ["to_device", "stream"],
  ["device_keys", "stream"],
  ["cross_signing_keys", "stream"],
  ["device_list_changes", "stream"],
  ["presence", "stream"],
  ["memberships", "stream"],
];

export class Homeserver extends EventEmitter {
  readonly serverName: string;
  readonly config: ResolvedConfig;
  readonly db: DatabaseAdapter;
  readonly media: MediaAdapter;
  readonly userAuth: ResolvedUserAuth;
  readonly logger: Logger;
  readonly router = new Router();
  readonly cluster: ClusterAdapter;
  readonly instanceId: string;
  readonly streams: StreamManager;
  readonly notifier: Notifier;
  readonly auth: AuthService;
  readonly rooms: RoomService;
  readonly keys: KeyService;
  readonly typing: TypingService;
  readonly push: PushService;
  readonly rateLimits: RateLimits;
  readonly admin: AdminService;
  readonly oauth: OAuthDelegation | null;
  readonly sso: SsoService | null;
  readonly federation: FederationService;
  readonly delayedEvents: DelayedEventService;
  readonly audit: AuditService;
  readonly settings: SettingsService;
  readonly adminRoom: AdminRoomService | null;
  readonly appservices: AppServiceService;
  readonly partialState: PartialStateService;
  readonly policyServers: PolicyServers;
  readonly threepids: ThreepidService;
  readonly identityServers: IdentityServers;
  /** `fetch` used for outgoing requests (push gateways, URL previews, OAuth). Overridable for testing. */
  readonly fetch: typeof globalThis.fetch;
  /** Resolves once storage is migrated and the server is ready to serve requests. */
  readonly ready: Promise<void>;
  private _signingKey: SigningKey | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: HomeserverOptions) {
    super();
    if (!options.homeserver) throw new Error("`homeserver` (server name) is required");
    this.serverName = options.homeserver;
    this.logger = options.logger ?? consoleLogger;
    const defaultRoomVersion = options.defaultRoomVersion ?? DEFAULT_ROOM_VERSION;
    if (!SUPPORTED_ROOM_VERSIONS.includes(defaultRoomVersion)) throw new Error(`Unsupported room version ${defaultRoomVersion}`);
    this.config = {
      serverName: options.homeserver,
      publicBaseUrl: options.publicBaseUrl ?? null,
      federationAddress: options.federationAddress ?? null,
      support:
        options.support && (options.support.contacts?.length || options.support.supportPage)
          ? {
              contacts: options.support.contacts ?? [],
              ...(options.support.supportPage ? { support_page: options.support.supportPage } : {}),
            }
          : null,
      loginViaExistingSession: options.loginViaExistingSession ?? true,
      threepid: { ...options.threepid, identityServerProtocol: options.threepid?.identityServerProtocol ?? "https" },
      registrationSharedSecret: options.registrationSharedSecret ?? null,
      defaultRoomVersion,
      accessTokenLifetimeMs: options.accessTokenLifetimeMs ?? null,
      maxSyncTimeoutMs: options.maxSyncTimeoutMs ?? 30000,
      urlPreviews: options.urlPreviews
        ? { allowPrivateAddresses: typeof options.urlPreviews === "object" && !!options.urlPreviews.allowPrivateAddresses }
        : null,
      thumbnailer: options.thumbnailer ?? null,
      rtc: options.rtc ?? {},
      serverNotices: {
        localpart: options.serverNotices?.localpart ?? "server",
        displayName: options.serverNotices?.displayName ?? "Server Notices",
        roomName: options.serverNotices?.roomName ?? "Server Notices",
      },
    };

    const db = options.databaseAdapter as DatabaseAdapter | undefined;
    if (db && typeof db.findOne === "function") {
      this.db = db;
    } else {
      this.logger.warn("No database adapter given; using in-memory storage (data is lost on restart)");
      this.db = memoryAdapter();
    }
    const media = options.mediaAdapter as MediaAdapter | undefined;
    this.media = media && typeof media.put === "function" ? media : memoryMedia();
    this.userAuth = resolveUserAuth(options.userAuthAdapter);
    this.cluster = options.cluster ?? localCluster();
    this.instanceId = newInstanceId();
    this.streams = new StreamManager(this.cluster, this.instanceId);
    this.notifier = new Notifier(this.cluster, this.instanceId);

    this.auth = new AuthService(this);
    this.rooms = new RoomService(this, !options.cluster);
    this.keys = new KeyService(this);
    this.typing = new TypingService(this);
    this.push = new PushService(this);
    this.admin = new AdminService(this);
    this.oauth = options.oauth ? new OAuthDelegation(this, options.oauth) : null;
    this.federation = new FederationService(this, options.federation);
    this.delayedEvents = new DelayedEventService(this, options.delayedEvents);
    this.audit = new AuditService(this, options.audit);
    this.settings = new SettingsService(this);
    this.appservices = new AppServiceService(this, options.appservices ?? []);
    this.partialState = new PartialStateService(this);
    this.policyServers = new PolicyServers(this);
    this.threepids = new ThreepidService(this);
    this.identityServers = new IdentityServers(this);
    const adminRoom = options.adminRoom === true ? {} : options.adminRoom || null;
    this.adminRoom = adminRoom && adminRoom.enabled !== false ? new AdminRoomService(this, adminRoom) : null;
    this.sso = options.sso?.providers.length ? new SsoService(this, options.sso) : null;
    if (this.sso && !options.publicBaseUrl) throw new Error("`publicBaseUrl` is required when SSO is configured");
    this.rateLimits =
      options.rateLimits === false
        ? new RateLimits(null)
        : new RateLimits(options.rateLimits?.limiter ?? memoryRateLimiter(), options.rateLimits?.rules);
    const cleanupEvery = options.cleanupIntervalMs ?? 10 * 60_000;
    if (cleanupEvery > 0) {
      this.cleanupTimer = setInterval(() => void this.cleanup().catch((err) => this.logger.warn("Cleanup failed", err)), cleanupEvery);
      this.cleanupTimer.unref?.();
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    registerRoutes(this.router);
    this.ready = this.init(options);
    this.ready.catch((err) => this.logger.error("Homeserver failed to start", err));
  }

  get signingKey(): SigningKey {
    if (!this._signingKey) throw new Error("Homeserver not ready");
    return this._signingKey;
  }

  private async init(options: HomeserverOptions): Promise<void> {
    // Several instances may start at once: migrate and create the signing key under a cluster lock.
    await this.cluster.lock("startup", async () => {
      await this.db.migrate?.(schema);
      if (options.signingKey) {
        this._signingKey = loadSigningKey(options.signingKey.keyId, options.signingKey.seed);
      } else {
        const row = await this.db.findOne("server_keys", []);
        if (row) {
          this._signingKey = loadSigningKey(row.key_id, row.seed);
        } else {
          this._signingKey = loadSigningKey(`a_${randomString(4)}`);
          await this.db.create("server_keys", { key_id: this._signingKey.keyId, seed: this._signingKey.seed });
        }
      }
    });
    for (const [table, field] of STREAM_TABLES) {
      const max = await this.db.max(table, field);
      if (max !== null) await this.streams.advanceTo(max);
    }
    const snap = await this.db.max("state_snapshots", "id");
    if (snap !== null) await this.streams.advanceTo(snap);
    const oldest = await this.db.findMany("events", { sortBy: { field: "stream", direction: "asc" }, limit: 1 });
    if (oldest[0] && oldest[0].stream < 0) await this.streams.lowerBackfillTo(oldest[0].stream);
    const oldestSnap = await this.db.findMany("state_snapshots", { sortBy: { field: "id", direction: "asc" }, limit: 1 });
    if (oldestSnap[0] && oldestSnap[0].id < 0) await this.streams.lowerBackfillTo(oldestSnap[0].id);
    await this.cluster.advance("federation_outbox", (await this.db.max("federation_outbox", "id")) ?? 0);
    if (this.federation.enabled) this.federation.sender.start();
    this.delayedEvents.start();
    this.appservices.start();
    if (this.federation.enabled) await this.partialState.resume();
  }

  /** Remove expired tokens, abandoned uploads and old notifications. */
  async cleanup(): Promise<void> {
    const now = Date.now();
    await this.db.delete("access_tokens", [{ field: "expires_ts", operator: "lt", value: now - 7 * 24 * 3600_000 }]);
    await this.db.delete("login_tokens", [{ field: "expires_ts", operator: "lt", value: now }]);
    for (const m of await this.db.findMany("media", {
      where: [
        { field: "pending", value: true },
        { field: "created_ts", operator: "lt", value: now - 24 * 3600_000 },
      ],
    })) {
      await this.media.delete?.(m.media_id);
      await this.db.delete("media", [{ field: "media_id", value: m.media_id }]);
    }
    await this.db.delete("notifications", [{ field: "ts", operator: "lt", value: now - 30 * 24 * 3600_000 }]);
    await this.audit.prune();
  }

  /** Stop background work and release long-polling requests. Call before shutting down your HTTP server. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.federation.sender.stop();
    this.delayedEvents.stop();
    this.appservices.stop();
    this.partialState.stop();
    await this.streams.stop();
    await this.cluster.close?.();
    this.notifier.notifyAll();
    this.emit("close");
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Effective registration mode: an admin's runtime setting overrides the configuration.
   * "open" | "token" | "closed".
   */
  async registrationMode(): Promise<"open" | "token" | "closed"> {
    const setting = await this.settings.get<string>("registration");
    if (setting === "open" || setting === "token" || setting === "closed") return setting;
    if (!this.userAuth.registrationEnabled) return "closed";
    return this.userAuth.registrationRequiresToken ? "token" : "open";
  }

  /** Whether `/register` is allowed right now, including the first-user exception. */
  async registrationAllowed(): Promise<boolean> {
    if ((await this.registrationMode()) !== "closed") return true;
    return !!this.adminRoom?.options.firstUserCanRegister && (await this.adminRoom.noUsersYet());
  }

  /** Run `fn` atomically when the database adapter supports transactions. */
  transaction<T>(fn: (db: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this.db.transaction ? this.db.transaction(fn) : fn(this.db);
  }

  /** The user's current profile, as included in member events. */
  async profile(userId: string): Promise<{ displayname?: string; avatar_url?: string }> {
    const user = await this.db.findOne("users", [{ field: "user_id", value: userId }]);
    const out: { displayname?: string; avatar_url?: string } = {};
    if (user?.displayname) out.displayname = user.displayname;
    if (user?.avatar_url) out.avatar_url = user.avatar_url;
    return out;
  }

  isLocalUser(userId: string): boolean {
    return userId.endsWith(`:${this.serverName}`);
  }
}

export function createHomeserver(options: HomeserverOptions): Homeserver {
  return new Homeserver(options);
}
