import { loadSigningKey, randomString } from "./core/crypto.js";
import { StreamManager, assertLeases, localCluster, newInstanceId } from "./core/cluster.js";
import { SUPPORTED_ROOM_VERSIONS } from "./core/events.js";
import { PartialStateService } from "./core/partialstate.js";
import { RoomService } from "./core/rooms.js";
import { addressPolicy, policyFetch } from "./core/outbound.js";
import { FederationService } from "./federation/index.js";
import { PolicyServers } from "./core/policy.js";
import { ThreepidService } from "./core/threepid.js";
import { IdentityServers } from "./core/identity.js";
import { AuthService } from "./core/auth.js";
import { KeyService } from "./core/keys.js";
import { Notifier } from "./core/notifier.js";
import { TypingService } from "./core/typing.js";
import { coalesceReads } from "./storage/batch.js";
import { ChangeTracker } from "./core/changes.js";
import { PushService } from "./core/push.js";
import { OAuthServer } from "./core/oauthserver.js";
import { SsoService } from "./core/sso.js";
import { AdminService } from "./core/admin.js";
import { OAuthDelegation } from "./core/oauth.js";
import { DelayedEventService } from "./core/delayed.js";
import { AuditService } from "./core/audit.js";
import { SettingsService } from "./core/settings.js";
import { AdminRoomService } from "./core/adminroom.js";
import { AppServiceService } from "./core/appservices.js";
import { RateLimits, memoryRateLimiter } from "./core/ratelimit.js";
import { resolveUserAuth } from "./adapters/auth.js";
import { memoryMedia } from "./adapters/media.js";
import { memoryAdapter } from "./storage/memory.js";
import { schema } from "./storage/schema.js";
import { Router } from "./http/router.js";
import { registerRoutes } from "./api/index.js";
import { EventEmitter } from "node:events";
// src/homeserver.ts
const consoleLogger = {
	debug: () => {},
	info: (...a) => console.info("[matrix]", ...a),
	warn: (...a) => console.warn("[matrix]", ...a),
	error: (...a) => console.error("[matrix]", ...a)
};
const STREAM_TABLES = [
	["events", "stream"],
	["account_data", "stream"],
	["receipts", "stream"],
	["to_device", "stream"],
	["device_keys", "stream"],
	["cross_signing_keys", "stream"],
	["device_list_changes", "stream"],
	["presence", "stream"],
	["memberships", "stream"]
];
var Homeserver = class extends EventEmitter {
	serverName;
	config;
	db;
	/**
	* Where keys last changed, when this is the only instance on its database (no cluster
	* adapter): /sync skips the reads that would find nothing new (#51). Null in a cluster.
	*/
	changes;
	media;
	userAuth;
	logger;
	router = new Router();
	cluster;
	instanceId;
	streams;
	notifier;
	auth;
	rooms;
	keys;
	typing;
	push;
	rateLimits;
	admin;
	oauth;
	oauthServer;
	sso;
	federation;
	delayedEvents;
	audit;
	settings;
	adminRoom;
	appservices;
	partialState;
	policyServers;
	threepids;
	identityServers;
	/** `fetch` for requests to addresses the operator configured (OAuth, SSO, application services). */
	fetch;
	/** Which addresses requests to user- or remote-chosen destinations may reach (see `allowPrivateAddresses`). */
	addressPolicy;
	/** `fetch` for user- or remote-chosen URLs: refuses private addresses unless allowed, never follows redirects. */
	publicFetch;
	/** Resolves once storage is migrated and the server is ready to serve requests. */
	ready;
	_signingKey = null;
	cleanupTimer = null;
	closed = false;
	constructor(options) {
		super();
		if (!options.homeserver) throw new Error("`homeserver` (server name) is required");
		this.serverName = options.homeserver;
		this.logger = options.logger ?? consoleLogger;
		const defaultRoomVersion = options.defaultRoomVersion ?? "10";
		if (!SUPPORTED_ROOM_VERSIONS.includes(defaultRoomVersion)) throw new Error(`Unsupported room version ${defaultRoomVersion}`);
		this.config = {
			serverName: options.homeserver,
			publicBaseUrl: options.publicBaseUrl ?? null,
			federationAddress: options.federationAddress ?? null,
			support: options.support && (options.support.contacts?.length || options.support.supportPage) ? {
				contacts: options.support.contacts ?? [],
				...options.support.supportPage ? { support_page: options.support.supportPage } : {}
			} : null,
			loginViaExistingSession: options.loginViaExistingSession ?? true,
			threepid: {
				...options.threepid,
				identityServerProtocol: options.threepid?.identityServerProtocol ?? "https"
			},
			registrationSharedSecret: options.registrationSharedSecret ?? null,
			defaultRoomVersion,
			accessTokenLifetimeMs: options.accessTokenLifetimeMs ?? null,
			maxSyncTimeoutMs: options.maxSyncTimeoutMs ?? 3e4,
			maxConcurrentSyncs: Math.max(1, options.maxConcurrentSyncs ?? 16),
			urlPreviews: options.urlPreviews ? { allowPrivateAddresses: typeof options.urlPreviews === "object" && !!options.urlPreviews.allowPrivateAddresses } : null,
			thumbnailer: options.thumbnailer ?? null,
			rtc: options.rtc ?? {},
			serverNotices: {
				localpart: options.serverNotices?.localpart ?? "server",
				displayName: options.serverNotices?.displayName ?? "Server Notices",
				roomName: options.serverNotices?.roomName ?? "Server Notices"
			}
		};
		this.changes = options.cluster ? null : new ChangeTracker();
		let db = options.databaseAdapter;
		if (!db || typeof db.findOne !== "function") {
			this.logger.warn("No database adapter given; using in-memory storage (data is lost on restart)");
			db = memoryAdapter();
		}
		this.db = coalesceReads(this.changes ? this.changes.wrap(db) : db);
		const media = options.mediaAdapter;
		this.media = media && typeof media.put === "function" ? media : memoryMedia();
		this.userAuth = resolveUserAuth(options.userAuthAdapter);
		this.cluster = options.cluster ?? localCluster();
		this.instanceId = newInstanceId();
		this.streams = new StreamManager(this.cluster, this.instanceId, (...args) => this.logger.warn(...args));
		this.notifier = new Notifier(this.cluster, this.instanceId, () => this.streams.lastAllocated, (fresh) => this.streams.position(fresh));
		this.streams.onAdvance = () => this.notifier.advanced();
		this.auth = new AuthService(this);
		this.rooms = new RoomService(this, !options.cluster);
		this.keys = new KeyService(this);
		this.typing = new TypingService(this);
		this.push = new PushService(this);
		this.admin = new AdminService(this);
		this.oauth = options.oauth ? new OAuthDelegation(this, options.oauth) : null;
		if (options.oauthServer && options.oauth) throw new Error("`oauthServer` and `oauth` (delegated OAuth) cannot be used together");
		if (options.oauthServer && !options.publicBaseUrl) throw new Error("`publicBaseUrl` is required for `oauthServer`");
		this.oauthServer = options.oauthServer ? new OAuthServer(this, options.oauthServer === true ? {} : options.oauthServer, options.publicBaseUrl) : null;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.addressPolicy = addressPolicy(options.allowPrivateAddresses);
		this.publicFetch = policyFetch(this.addressPolicy, options.fetch);
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
		this.sso = options.sso && (options.sso.providers.length || options.oauthServer) ? new SsoService(this, options.sso) : null;
		if (this.sso && !options.publicBaseUrl) throw new Error("`publicBaseUrl` is required when SSO is configured");
		this.rateLimits = options.rateLimits === false ? new RateLimits(null) : new RateLimits(options.rateLimits?.limiter ?? memoryRateLimiter(), options.rateLimits?.rules);
		const cleanupEvery = options.cleanupIntervalMs ?? 6e5;
		if (cleanupEvery > 0) {
			this.cleanupTimer = setInterval(() => void this.cleanup().catch((err) => this.logger.warn("Cleanup failed", err)), cleanupEvery);
			this.cleanupTimer.unref?.();
		}
		registerRoutes(this.router);
		this.ready = this.init(options);
		this.ready.catch((err) => this.logger.error("Homeserver failed to start", err));
	}
	get signingKey() {
		if (!this._signingKey) throw new Error("Homeserver not ready");
		return this._signingKey;
	}
	async init(options) {
		if (!this.db.transaction) this.logger.warn("The database adapter has no transaction(): a crash during a write can leave a room event half stored");
		await this.cluster.lock("startup", async () => {
			await this.db.migrate?.(schema);
			if (options.signingKey) this._signingKey = loadSigningKey(options.signingKey.keyId, options.signingKey.seed);
			else {
				const row = await this.db.findOne("server_keys", []);
				if (row) this._signingKey = loadSigningKey(row.key_id, row.seed);
				else {
					this._signingKey = loadSigningKey(`a_${randomString(4)}`);
					await this.db.create("server_keys", {
						key_id: this._signingKey.keyId,
						seed: this._signingKey.seed
					});
				}
			}
		});
		for (const [table, field] of STREAM_TABLES) {
			const max = await this.db.max(table, field);
			if (max !== null) await this.streams.advanceTo(max);
		}
		const snap = await this.db.max("state_snapshots", "id");
		if (snap !== null) await this.streams.advanceTo(snap);
		this.changes?.start(await this.streams.position(true));
		const oldest = await this.db.findMany("events", {
			sortBy: {
				field: "stream",
				direction: "asc"
			},
			limit: 1
		});
		if (oldest[0] && oldest[0].stream < 0) await this.streams.lowerBackfillTo(oldest[0].stream);
		const oldestSnap = await this.db.findMany("state_snapshots", {
			sortBy: {
				field: "id",
				direction: "asc"
			},
			limit: 1
		});
		if (oldestSnap[0] && oldestSnap[0].id < 0) await this.streams.lowerBackfillTo(oldestSnap[0].id);
		for (const model of [
			"federation_outbox",
			"audit_log",
			"event_reports",
			"user_reports",
			"appservice_outbox"
		]) await this.cluster.advance(model, await this.db.max(model, "id") ?? 0);
		if (this.federation.enabled) this.federation.sender.start();
		this.delayedEvents.start();
		this.appservices.start();
		if (this.federation.enabled) await this.partialState.resume();
	}
	/** Remove expired tokens, abandoned uploads and old notifications. */
	async cleanup() {
		const now = Date.now();
		await this.db.delete("access_tokens", [{
			field: "expires_ts",
			operator: "lt",
			value: now - 6048e5
		}, {
			field: "refresh_used",
			value: true
		}]);
		await this.oauthServer?.prune();
		await this.db.delete("login_tokens", [{
			field: "expires_ts",
			operator: "lt",
			value: now
		}]);
		for (const m of await this.db.findMany("media", { where: [{
			field: "pending",
			value: true
		}, {
			field: "created_ts",
			operator: "lt",
			value: now - 864e5
		}] })) {
			await this.media.delete?.(m.media_id);
			await this.db.delete("media", [{
				field: "media_id",
				value: m.media_id
			}]);
		}
		await this.db.delete("notifications", [{
			field: "ts",
			operator: "lt",
			value: now - 2592e6
		}]);
		await this.audit.prune();
	}
	/** Stop background work and release long-polling requests. Call before shutting down your HTTP server. */
	async close() {
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
	get isClosed() {
		return this.closed;
	}
	/**
	* Effective registration mode: an admin's runtime setting overrides the configuration.
	* "open" | "token" | "closed".
	*/
	async registrationMode() {
		const setting = await this.settings.get("registration");
		if (setting === "open" || setting === "token" || setting === "closed") return setting;
		if (!this.userAuth.registrationEnabled) return "closed";
		return this.userAuth.registrationRequiresToken ? "token" : "open";
	}
	/** Whether `/register` is allowed right now, including the first-user exception. */
	async registrationAllowed() {
		if (await this.registrationMode() !== "closed") return true;
		return !!this.adminRoom?.options.firstUserCanRegister && await this.adminRoom.noUsersYet();
	}
	/** Run `fn` atomically when the database adapter supports transactions. */
	transaction(fn) {
		const fenced = async (db) => {
			assertLeases();
			const out = await fn(db);
			assertLeases();
			return out;
		};
		return this.db.transaction ? this.db.transaction(fenced) : fenced(this.db);
	}
	/** The user's current profile, as included in member events. */
	async profile(userId) {
		const user = await this.db.findOne("users", [{
			field: "user_id",
			value: userId
		}]);
		const out = {};
		if (user?.displayname) out.displayname = user.displayname;
		if (user?.avatar_url) out.avatar_url = user.avatar_url;
		return out;
	}
	isLocalUser(userId) {
		return userId.endsWith(`:${this.serverName}`);
	}
};
function createHomeserver(options) {
	return new Homeserver(options);
}
export { Homeserver, createHomeserver };

//# sourceMappingURL=homeserver.js.map