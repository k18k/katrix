import { PartialStateService } from "#core/partialstate.ts";
import { PolicyServers } from "#core/policy.ts";
import { ThreepidService, type ThreepidOptions } from "#core/threepid.ts";
import { IdentityServers } from "#core/identity.ts";
import { EventEmitter } from "node:events";
import { AuthService } from "#core/auth.ts";
import { type SigningKey } from "#core/crypto.ts";
import { KeyService } from "#core/keys.ts";
import { Notifier } from "#core/notifier.ts";
import { StreamManager, type ClusterAdapter } from "#core/cluster.ts";
import { RoomService } from "#core/rooms.ts";
import { TypingService } from "#core/typing.ts";
import { PushService } from "#core/push.ts";
import { AdminService, type ServerNoticesOptions } from "#core/admin.ts";
import { OAuthDelegation, type OAuthDelegationOptions } from "#core/oauth.ts";
import { OAuthServer, type OAuthServerOptions } from "#core/oauthserver.ts";
import { SsoService, type SsoOptions } from "#core/sso.ts";
import { FederationService, type FederationOptions } from "#federation/index.ts";
import { DelayedEventService, type DelayedEventsOptions } from "#core/delayed.ts";
import type { RtcOptions } from "#api/rtc.ts";
import { AuditService, type AuditOptions } from "#core/audit.ts";
import { SettingsService } from "#core/settings.ts";
import { AdminRoomService, type AdminRoomOptions } from "#core/adminroom.ts";
import { AppServiceService, type AppServiceRegistration } from "#core/appservices.ts";
import { RateLimits, type RateLimitAction, type RateLimiter, type RateLimitRule } from "#core/ratelimit.ts";
import { type ResolvedUserAuth, type UserAuthAdapter } from "#adapters/auth.ts";
import { type MediaAdapter, type Thumbnailer } from "#adapters/media.ts";
import { ChangeTracker } from "#core/changes.ts";
import type { DatabaseAdapter } from "#storage/types.ts";
import { Router } from "#http/router.ts";
import { M } from "#core/m.ts";
import { type AddressPolicy } from "#core/outbound.ts";
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
        contacts?: {
            role: typeof M.ROLE.ADMIN | typeof M.ROLE.SECURITY | (string & {});
            matrix_id?: string;
            email_address?: string;
        }[];
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
    signingKey?: {
        keyId: string;
        seed: string;
    };
    /** Room version used when clients do not ask for one. Default: "10". */
    defaultRoomVersion?: string;
    /** When set, clients requesting refresh tokens get access tokens that expire after this many ms. */
    accessTokenLifetimeMs?: number;
    /** Maximum `/sync` long-poll duration in ms. Default: 30000. */
    maxSyncTimeoutMs?: number;
    /**
     * How many `/sync` responses one process builds at once (default 16). Requests woken together
     * wait in the process instead of queueing their database reads ahead of everything else.
     */
    maxConcurrentSyncs?: number;
    /**
     * Enables `/preview_url`. Off by default because it makes the server fetch arbitrary URLs.
     * Private/internal addresses stay blocked unless `allowPrivateAddresses` is set.
     */
    urlPreviews?: boolean | {
        allowPrivateAddresses?: boolean;
    };
    logger?: Logger;
    /** Custom `fetch` for outgoing HTTP requests. */
    fetch?: typeof globalThis.fetch;
    /**
     * Let requests to addresses that users or remote servers choose (federation, push gateways,
     * identity servers, URL previews, remote media) reach private addresses: localhost, LAN and
     * other non-public ranges. `true` allows all of them, a list allows those ranges only (e.g.
     * `["127.0.0.1/32"]` for a push gateway on the same machine). Default: none.
     */
    allowPrivateAddresses?: boolean | string[];
    /**
     * Rate limiting. `false` disables it; otherwise per-action overrides and an optional
     * shared limiter (defaults to an in-memory token bucket). Admins are never limited.
     */
    /** Delegate authentication to an external OAuth 2.0 / OIDC provider (disables password login and registration). */
    oauth?: OAuthDelegationOptions;
    /**
     * Serve the spec's OAuth 2.0 API: users log in on the server's own web pages, with a password
     * and/or the upstream providers of `sso` (e.g. `githubProvider`). Requires `publicBaseUrl`.
     * Cannot be combined with `oauth`.
     */
    oauthServer?: boolean | OAuthServerOptions;
    /**
     * Upstream identity providers (OpenID Connect, or OAuth 2.0 such as GitHub) for `m.login.sso`
     * and the `oauthServer` login page. Requires `publicBaseUrl`.
     */
    sso?: SsoOptions;
    /**
     * Coordination between instances. The default (`localCluster()`) supports one process;
     * use `postgresCluster()` to scale horizontally.
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
    rateLimits?: false | {
        limiter?: RateLimiter;
        rules?: Partial<Record<RateLimitAction, RateLimitRule>>;
    };
    /** Interval for background cleanup of expired data, in ms. Default: 10 minutes. `0` disables it. */
    cleanupIntervalMs?: number;
}
export interface ResolvedConfig {
    serverName: string;
    publicBaseUrl: string | null;
    federationAddress: string | null;
    support: {
        contacts: {
            role: string;
            matrix_id?: string;
            email_address?: string;
        }[];
        support_page?: string;
    } | null;
    loginViaExistingSession: boolean;
    threepid: ThreepidOptions & {
        identityServerProtocol: "https" | "http";
    };
    registrationSharedSecret: string | null;
    defaultRoomVersion: string;
    accessTokenLifetimeMs: number | null;
    maxSyncTimeoutMs: number;
    maxConcurrentSyncs: number;
    urlPreviews: {
        allowPrivateAddresses: boolean;
    } | null;
    serverNotices: Required<ServerNoticesOptions>;
    thumbnailer: Thumbnailer | null;
    rtc: RtcOptions;
}
export declare class Homeserver extends EventEmitter {
    readonly serverName: string;
    readonly config: ResolvedConfig;
    readonly db: DatabaseAdapter;
    /**
     * Where keys last changed, when this is the only instance on its database (no cluster
     * adapter): /sync skips the reads that would find nothing new (#51). Null in a cluster.
     */
    readonly changes: ChangeTracker | null;
    readonly media: MediaAdapter;
    readonly userAuth: ResolvedUserAuth;
    readonly logger: Logger;
    readonly router: Router;
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
    readonly oauthServer: OAuthServer | null;
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
    /** `fetch` for requests to addresses the operator configured (OAuth, SSO, application services). */
    readonly fetch: typeof globalThis.fetch;
    /** Which addresses requests to user- or remote-chosen destinations may reach (see `allowPrivateAddresses`). */
    readonly addressPolicy: AddressPolicy;
    /** `fetch` for user- or remote-chosen URLs: refuses private addresses unless allowed, never follows redirects. */
    readonly publicFetch: typeof globalThis.fetch;
    /** Resolves once storage is migrated and the server is ready to serve requests. */
    readonly ready: Promise<void>;
    private _signingKey;
    private cleanupTimer;
    private closed;
    constructor(options: HomeserverOptions);
    get signingKey(): SigningKey;
    private init;
    /** Remove expired tokens, abandoned uploads and old notifications. */
    cleanup(): Promise<void>;
    /** Stop background work and release long-polling requests. Call before shutting down your HTTP server. */
    close(): Promise<void>;
    get isClosed(): boolean;
    /**
     * Effective registration mode: an admin's runtime setting overrides the configuration.
     * "open" | "token" | "closed".
     */
    registrationMode(): Promise<"open" | "token" | "closed">;
    /** Whether `/register` is allowed right now, including the first-user exception. */
    registrationAllowed(): Promise<boolean>;
    /** Run `fn` atomically when the database adapter supports transactions. */
    transaction<T>(fn: (db: DatabaseAdapter) => Promise<T>): Promise<T>;
    /** The user's current profile, as included in member events. */
    profile(userId: string): Promise<{
        displayname?: string;
        avatar_url?: string;
    }>;
    isLocalUser(userId: string): boolean;
}
export declare function createHomeserver(options: HomeserverOptions): Homeserver;
