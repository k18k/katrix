import { ConnectionError, MatrixError } from "./http/errors.js";
import { AccountApi } from "./account/account.js";
import { AdminApi } from "./account/admin.js";
import { DevicesApi } from "./account/devices.js";
import { PresenceApi, ProfileApi } from "./account/profile.js";
import { isAbortError, newAbortController, setTimer, sleep } from "./platform.js";
import { describeError, noopLogger } from "./util/logger.js";
import { encodeBase64 } from "./shared/base64.js";
import { MatrixHttpApi } from "./http/api.js";
import { CredentialsTokenProvider } from "./auth/login.js";
import { nobleCryptoPrimitives } from "./crypto/noble.js";
import { TypedEmitter } from "./util/emitter.js";
import { E2EEEngine } from "./e2ee/engine.js";
import { fetchHttpAdapter } from "./http/adapter.js";
import { DirectoryApi } from "./directory/directory.js";
import { MediaApi } from "./media/media.js";
import { PushApi } from "./push/push.js";
import { SpacesApi } from "./spaces/spaces.js";
import { CallsApi } from "./voip/calls.js";
import { MatrixEvent } from "./models/event.js";
import { relationOf } from "./models/relations.js";
import { Room } from "./models/room.js";
import { nativeE2EEProtocol } from "./protocol/native.js";
import { STORES } from "./storage/adapter.js";
import { MemoryStorage } from "./storage/memory.js";
import { Store } from "./storage/store.js";
import { SyncV3Transport } from "./sync/v3.js";
// src/client.ts
const MAX_BACKOFF_MS = 3e4;
function isVerificationEvent(event) {
	return event.type.startsWith("m.key.verification.") || event.type === "m.room.message" && event.content.msgtype === "m.key.verification.request";
}
/** How long a missing room key may take to arrive before the backup and other devices are asked. */
const KEY_WAIT_MS = 5e3;
/**
* A Matrix client: sync, rooms, timelines, sending, and end-to-end encryption.
*
* One /sync round is processed as one unit of work: its to-device messages (room keys, Olm
* sessions, used one-time keys), device list changes, room updates and the new sync token are
* stored together. A crash in between repeats the round instead of losing keys: to-device
* messages are deleted on the server only once a sync with the next token is made.
*/
var MatrixClient = class extends TypedEmitter {
	api;
	userId;
	deviceId;
	store;
	e2ee;
	/** Password, deactivation, 3PIDs, account data, filters, ignored users, tokens. */
	account;
	devices;
	profile;
	presence;
	/** Aliases, the public room directory, room summaries, the user directory, third-party networks. */
	directory;
	admin;
	/** Uploads, downloads, thumbnails, URL previews, encrypted attachments. */
	media;
	/** Pushers, push rules, the notification list, and evaluating rules locally. */
	push;
	/** Creating spaces, their children and parents, the space hierarchy. */
	spaces;
	/** Voice and video calls (signalling; media through the app's WebRTC). */
	calls;
	logger;
	primitives;
	transport;
	opts;
	tokens;
	rooms = /* @__PURE__ */ new Map();
	syncToken;
	running = false;
	syncAbort;
	loop;
	prepared = false;
	txnCounter = 0;
	/** Encrypted events waiting for their room key, by `${roomId}|${sessionId}`. */
	awaitingKeys = /* @__PURE__ */ new Map();
	/** Our events being sent, by transaction ID, to match the copy that comes down /sync. */
	localEchoes = /* @__PURE__ */ new Map();
	accountData = /* @__PURE__ */ new Map();
	presenceByUser = /* @__PURE__ */ new Map();
	/** set_presence for /sync: from the options, then from the last presence.set(). */
	setPresence;
	started;
	loaded = false;
	/** During a sync round after the first: the new events from others, to evaluate push rules on. */
	notifyQueue;
	/** During a sync round: the new live events, for the m.call.* among them once decrypted. */
	callQueue;
	/** Encrypted events still to be evaluated once decrypted. */
	notifyOnDecrypt = /* @__PURE__ */ new WeakSet();
	constructor(opts) {
		super();
		this.opts = opts;
		this.logger = opts.logger ?? noopLogger;
		this.onListenerError = (event, e) => {
			this.logger.error("an event listener threw", {
				event: String(event),
				...describeError(e)
			});
			if (event !== "error") this.emit("error", e);
		};
		const http = opts.http ?? fetchHttpAdapter();
		const userId = opts.credentials?.userId ?? opts.userId;
		const deviceId = opts.credentials?.deviceId ?? opts.deviceId;
		if (!userId || !deviceId) throw new Error("A client needs credentials, or userId and deviceId with a token provider");
		this.userId = userId;
		this.deviceId = deviceId;
		this.tokens = opts.tokenProvider ?? (opts.credentials ? new CredentialsTokenProvider({
			credentials: opts.credentials,
			baseUrl: opts.baseUrl,
			http,
			store: opts.credentialsStore
		}) : (() => {
			throw new Error("A client needs credentials or a token provider");
		})());
		this.api = new MatrixHttpApi({
			baseUrl: opts.baseUrl,
			http,
			tokens: this.tokens,
			logger: this.logger
		});
		this.store = new Store(opts.storage ?? new MemoryStorage());
		this.account = new AccountApi(this.api, userId);
		this.devices = new DevicesApi(this.api);
		this.profile = new ProfileApi(this.api, userId);
		this.setPresence = opts.sync?.setPresence;
		this.presence = new PresenceApi(this.api, userId, (presence) => this.setPresence = presence);
		this.directory = new DirectoryApi(this.api);
		this.admin = new AdminApi(this.api);
		this.push = new PushApi(this.api, userId, (type) => this.accountData.get(type));
		this.spaces = new SpacesApi(this);
		this.calls = new CallsApi({
			api: this.api,
			logger: this.logger,
			userId,
			factory: opts.calls?.peerConnectionFactory,
			sendRoomEvent: (roomId, type, content) => this.sendEvent(roomId, type, content),
			makeId: () => encodeBase64(this.primitives.randomBytes(12), { urlSafe: true })
		});
		const e2ee = opts.e2ee === false ? void 0 : opts.e2ee ?? {};
		this.primitives = e2ee?.primitives ?? nobleCryptoPrimitives();
		this.media = new MediaApi(this.api, this.primitives);
		if (e2ee) this.e2ee = new E2EEEngine({
			api: this.api,
			primitives: this.primitives,
			accountData: {
				get: async (type) => this.accountData.get(type) ?? await this.account.getAccountData(type),
				set: async (type, content) => {
					await this.account.setAccountData(type, content);
					this.accountData.set(type, content);
				}
			},
			sendRoomEvent: (roomId, type, content) => this.sendEvent(roomId, type, content),
			store: this.store,
			protocol: e2ee.protocol ?? nativeE2EEProtocol(this.primitives),
			pickleKey: e2ee.pickleKey,
			onlyVerifiedDevices: e2ee.onlyVerifiedDevices,
			logger: this.logger,
			userId,
			deviceId,
			txnId: () => this.makeTxnId()
		});
		this.transport = opts.sync?.transport ?? new SyncV3Transport(this.api, opts.sync);
		if (this.e2ee) this.e2ee.onNewSessions = (sessions) => {
			for (const s of sessions) this.retryAwaiting(s.roomId, s.sessionId);
		};
	}
	/** A transaction ID unique for this device (random, so restarts never reuse one). */
	makeTxnId() {
		return `m${Date.now().toString(36)}.${(this.txnCounter++).toString(36)}.${encodeBase64(this.primitives.randomBytes(6), { urlSafe: true })}`;
	}
	getRoom(roomId) {
		return this.rooms.get(roomId);
	}
	getRooms() {
		return [...this.rooms.values()];
	}
	getAccountData(type) {
		return this.accountData.get(type);
	}
	/** A user's latest presence from /sync (this.presence.get asks the server). */
	getPresence(userId) {
		return this.presenceByUser.get(userId);
	}
	isPrepared() {
		return this.prepared;
	}
	/** Load stored state, set up encryption, and start syncing. Resolves once the loop runs. */
	start() {
		if (!this.started) this.started = (async () => {
			if (!this.loaded) await this.loadFromStore();
			this.loaded = true;
			await this.e2ee?.init();
			await this.decryptStoredTimelines();
			this.running = true;
			this.loop = this.syncLoop();
		})();
		return this.started;
	}
	/** Stop syncing (in-flight sends finish). */
	async stop() {
		this.running = false;
		this.syncAbort?.abort();
		await this.loop?.catch(() => {});
		this.loop = void 0;
		this.started = void 0;
		this.emit("sync", "stopped");
	}
	/** Resolves after the first sync round has been processed (immediately if it has). */
	async waitForPrepared() {
		if (this.prepared) return;
		await this.waitFor("sync", (s) => s === "prepared");
	}
	/**
	* Log out on the server and stop. The device's keys are gone on the server then, so its
	* stored state is useless: `clearStorage` (default true) deletes it, keys included.
	*/
	async logout(opts = {}) {
		await this.stop();
		await this.api.endpoint("POST /v3/logout", {}, { body: {} });
		if (opts.clearStorage !== false) await this.clearStorage();
	}
	/** Delete everything this client stored (rooms, sync token, crypto state). The client is unusable afterwards. */
	async clearStorage() {
		await this.store.transaction(async (tx) => {
			for (const store of STORES) for (const [key] of await tx.list(store, "")) tx.delete(store, key);
		});
		this.rooms.clear();
		this.accountData.clear();
		this.syncToken = void 0;
	}
	async close() {
		await this.stop();
		await this.store.close();
	}
	async syncLoop() {
		let failures = 0;
		while (this.running) {
			this.syncAbort = newAbortController();
			try {
				const result = await this.transport.sync({
					since: this.syncToken,
					timeoutMs: this.syncToken ? this.opts.sync?.pollTimeoutMs ?? 3e4 : 0,
					signal: this.syncAbort.signal,
					setPresence: this.setPresence
				});
				if (!this.running) break;
				await this.processSync(result);
				failures = 0;
				if (!this.prepared) {
					this.prepared = true;
					this.emit("sync", "prepared");
				} else this.emit("sync", "syncing");
			} catch (e) {
				if (!this.running || isAbortError(e)) break;
				if (e instanceof MatrixError && e.status === 401 && e.errcode === "M_UNKNOWN_TOKEN") {
					this.logger.warn("the access token was rejected; stopping", { softLogout: e.data.soft_logout === true });
					this.running = false;
					this.emit("loggedOut", e);
					break;
				}
				failures++;
				const wait = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(failures, 6));
				if (!(e instanceof ConnectionError || e instanceof MatrixError)) this.logger.error("processing a sync response failed", describeError(e));
				else this.logger.warn("sync failed, retrying", {
					wait,
					...describeError(e)
				});
				this.emit("sync", "error", e);
				this.emit("error", e);
				try {
					await sleep(wait, this.syncAbort.signal);
				} catch {
					break;
				}
			}
		}
	}
	/** Apply one sync result: crypto and rooms in one unit of work, then events and decryption. */
	async processSync(result) {
		const emits = [];
		const toDecrypt = [];
		const encryptedJoins = /* @__PURE__ */ new Set();
		let outcome = {
			events: result.toDevice.map((event) => ({ event })),
			newSessions: [],
			wedged: []
		};
		const notifyQueue = [];
		this.notifyQueue = this.prepared ? notifyQueue : void 0;
		const callQueue = [];
		this.callQueue = callQueue;
		await this.store.transaction(async (tx) => {
			if (this.e2ee) outcome = await this.e2ee.processSync(tx, result);
			for (const ev of result.accountData) {
				if (typeof ev.type !== "string") continue;
				this.accountData.set(ev.type, ev.content);
				tx.put("client", `account_data|${ev.type}`, ev.content);
				emits.push(() => this.emit("accountData", ev));
			}
			for (const [roomId, update] of Object.entries(result.rooms.join)) this.applyJoined(tx, roomId, update, emits, toDecrypt, encryptedJoins);
			for (const [roomId, update] of Object.entries(result.rooms.invite)) this.applyInvite(tx, roomId, "invite", update.strippedState, emits);
			for (const [roomId, update] of Object.entries(result.rooms.knock)) this.applyInvite(tx, roomId, "knock", update.strippedState, emits);
			for (const [roomId, update] of Object.entries(result.rooms.leave)) {
				const room = this.roomFor(roomId, "leave", emits);
				this.setMembership(room, "leave", emits);
				this.applyStateAndTimeline(tx, room, update.state, update.timeline, false, emits, toDecrypt, encryptedJoins, update.stateAfter);
				this.persistRoom(tx, room);
			}
			if (this.e2ee && encryptedJoins.size > 0) await this.e2ee.devices.track(tx, encryptedJoins);
			tx.put("sync", "token", result.nextBatch);
		});
		this.notifyQueue = void 0;
		this.syncToken = result.nextBatch;
		for (const emit of emits) emit();
		for (const { event, decrypted } of outcome.events) {
			this.emit("toDevice", event, decrypted);
			if (this.e2ee && event.type.startsWith("m.key.verification.")) await this.e2ee.verification.handleToDevice(event).catch((e) => this.logger.warn("a verification message failed", describeError(e)));
		}
		for (const ev of result.presence) {
			if (typeof ev.sender === "string") this.presenceByUser.set(ev.sender, ev.content);
			this.emit("presence", ev);
		}
		if (this.e2ee) {
			await this.e2ee.afterSync(result, outcome);
			if (encryptedJoins.size > 0) await this.e2ee.devices.refresh([...encryptedJoins]).catch((e) => this.logger.warn("device query failed", describeError(e)));
			for (const { event, room } of toDecrypt) await this.decryptAndEmit(event, room);
			for (const s of outcome.newSessions) await this.retryAwaiting(s.roomId, s.sessionId);
		}
		this.callQueue = void 0;
		const callEvents = callQueue.filter(({ event }) => event.type.startsWith("m.call."));
		if (callEvents.length) await this.calls.handleEvents(callEvents);
		for (const { event, room } of notifyQueue) if (event.isEncrypted() && event.decryptionStatus !== "decrypted") this.notifyOnDecrypt.add(event);
		else this.notifyIfRulesSay(event, room);
	}
	async routeVerification(event) {
		await this.e2ee?.verification.handleRoomEvent(event).catch((e) => this.logger.warn("a verification event failed", describeError(e)));
	}
	notifyIfRulesSay(event, room) {
		const outcome = this.push.evaluate(event, room);
		if (outcome.notify) this.emit("notification", event, room, outcome);
	}
	/**
	* Unread counts. For an unencrypted room they are the server's. For an encrypted room the
	* server can only count every encrypted message, so they are counted here, on the decrypted
	* events after the user's latest receipt (their own messages count as read): `exact` is false
	* when that receipt is older than the timeline in memory, and the count is a lower bound then.
	*/
	getUnreadCounts(roomId) {
		const room = this.rooms.get(roomId);
		if (!room) return {
			notification: 0,
			highlight: 0,
			exact: true
		};
		if (!room.isEncrypted()) return {
			...room.unreadNotifications,
			exact: true
		};
		const read = /* @__PURE__ */ new Set([room.readReceipt(this.userId, "m.read")?.eventId, room.readReceipt(this.userId, "m.read.private")?.eventId]);
		let notification = 0;
		let highlight = 0;
		const events = room.timeline.events;
		for (let i = events.length - 1; i >= 0; i--) {
			const e = events[i];
			if (e.eventId && read.has(e.eventId) || e.sender === this.userId) return {
				notification,
				highlight,
				exact: true
			};
			if (e.isEncrypted() && e.decryptionStatus !== "decrypted") continue;
			const outcome = this.push.evaluate(e, room);
			if (outcome.notify) notification++;
			if (outcome.notify && outcome.highlight) highlight++;
		}
		return {
			notification,
			highlight,
			exact: room.timeline.atStart
		};
	}
	roomFor(roomId, membership, emits) {
		let room = this.rooms.get(roomId);
		if (!room) {
			room = new Room(roomId, this.userId, membership, { maxTimelineEvents: this.opts.maxTimelineEvents });
			this.rooms.set(roomId, room);
			const r = room;
			emits.push(() => this.emit("room", r));
			emits.push(() => this.emit("room.membership", r, membership, void 0));
		}
		return room;
	}
	setMembership(room, membership, emits) {
		const previous = room.membership;
		if (previous === membership) return;
		room.membership = membership;
		emits.push(() => this.emit("room.membership", room, membership, previous));
	}
	applyInvite(tx, roomId, membership, stripped, emits) {
		const room = this.roomFor(roomId, membership, emits);
		this.setMembership(room, membership, emits);
		room.inviteState = stripped.filter((e) => typeof e?.type === "string");
		this.persistRoom(tx, room);
	}
	applyJoined(tx, roomId, update, emits, toDecrypt, encryptedJoins) {
		const room = this.roomFor(roomId, "join", emits);
		this.setMembership(room, "join", emits);
		room.inviteState = [];
		if (update.summary) room.summary = {
			heroes: update.summary.heroes?.length ? update.summary.heroes : room.summary.heroes,
			joinedMemberCount: update.summary.joinedMemberCount ?? room.summary.joinedMemberCount,
			invitedMemberCount: update.summary.invitedMemberCount ?? room.summary.invitedMemberCount
		};
		if (update.unreadNotifications) room.unreadNotifications = {
			highlight: update.unreadNotifications.highlight_count ?? room.unreadNotifications.highlight,
			notification: update.unreadNotifications.notification_count ?? room.unreadNotifications.notification
		};
		this.applyStateAndTimeline(tx, room, update.state, update.timeline, update.initial === true, emits, toDecrypt, encryptedJoins, update.stateAfter);
		if (update.unreadThreadNotifications) {
			room.threadNotifications.clear();
			for (const [threadId, c] of Object.entries(update.unreadThreadNotifications)) room.threadNotifications.set(threadId, {
				highlight: c?.highlight_count ?? 0,
				notification: c?.notification_count ?? 0
			});
		}
		for (const ev of update.ephemeral) this.applyEphemeral(room, ev, emits);
		for (const ev of update.accountData) {
			if (typeof ev.type !== "string") continue;
			room.accountData.set(ev.type, ev.content);
			emits.push(() => this.emit("room.accountData", room, ev));
		}
		this.persistRoom(tx, room);
	}
	applyStateAndTimeline(tx, room, state, timeline, replaceState, emits, toDecrypt, encryptedJoins, stateAfter = false) {
		if (replaceState && state.length > 0 && room.state.all().length > 0) {
			for (const old of room.state.all()) tx.delete("room_state", `${room.roomId}|${old.wire.type}|${old.stateKey}`);
			room.state.clear();
		}
		if (!stateAfter) for (const raw of state) this.applyState(tx, room, {
			...raw,
			room_id: room.roomId
		}, emits, encryptedJoins);
		if (timeline.limited) room.timeline.reset(timeline.prevBatch);
		else if (room.timeline.events.length === 0 && room.timeline.backToken === void 0) room.timeline.backToken = timeline.prevBatch;
		const fresh = [];
		for (const raw of timeline.events) {
			const wire = {
				...raw,
				room_id: room.roomId
			};
			const txnId = wire.unsigned?.transaction_id;
			const echo = typeof txnId === "string" && wire.sender === this.userId ? this.localEchoes.get(txnId) : void 0;
			if (echo && echo.room === room) {
				const clear = {
					type: echo.event.type,
					content: echo.event.content
				};
				const wasClear = !echo.event.isEncrypted();
				echo.event.wire = wire;
				if (wasClear && wire.type === "m.room.encrypted" && this.e2ee) echo.event.setDecrypted(clear, {
					senderCurve25519Key: this.e2ee.identityKeys.curve25519,
					claimedEd25519Key: this.e2ee.identityKeys.ed25519,
					senderDeviceId: this.deviceId,
					authenticity: "authenticated"
				});
				echo.event.localStatus = "sent";
				room.timeline.index(echo.event);
				this.localEchoes.delete(txnId);
				if (wire.state_key !== void 0) this.applyState(tx, room, wire, emits, encryptedJoins);
				continue;
			}
			const known = wire.event_id ? room.timeline.find(wire.event_id) : void 0;
			if (known) {
				if (known.isEncrypted() && known.decryptionStatus === "pending") toDecrypt.push({
					event: known,
					room
				});
				continue;
			}
			const event = new MatrixEvent(wire);
			if (wire.state_key !== void 0) this.applyState(tx, room, wire, emits, encryptedJoins);
			if (wire.type === "m.room.redaction") this.applyRedaction(room, wire, emits);
			fresh.push(event);
		}
		for (const event of room.timeline.append(fresh)) {
			this.indexRelations(event, room, emits, toDecrypt);
			if (event.isEncrypted()) toDecrypt.push({
				event,
				room
			});
			if (this.notifyQueue && room.membership === "join" && event.sender !== this.userId) this.notifyQueue.push({
				event,
				room
			});
			if (this.callQueue && room.membership === "join") this.callQueue.push({
				event,
				room
			});
			if (!event.isEncrypted() && this.e2ee && isVerificationEvent(event)) emits.push(() => void this.routeVerification(event));
			emits.push(() => this.emit("room.timeline", event, room, { live: true }));
		}
		if (stateAfter) for (const raw of state) this.applyState(tx, room, {
			...raw,
			room_id: room.roomId
		}, emits, encryptedJoins);
	}
	applyState(tx, room, raw, emits, encryptedJoins) {
		if (typeof raw.type !== "string" || typeof raw.state_key !== "string") return;
		const event = new MatrixEvent(raw);
		const previous = room.state.set(event);
		tx.put("room_state", `${room.roomId}|${raw.type}|${raw.state_key}`, raw);
		if (raw.type === "m.room.member" && room.isEncrypted()) {
			const m = raw.content.membership;
			if (m === "join" || m === "invite") encryptedJoins.add(raw.state_key);
		}
		if (raw.type === "m.room.encryption") {
			for (const m of room.state.members()) if (m.membership === "join" || m.membership === "invite") encryptedJoins.add(m.userId);
		}
		emits.push(() => this.emit("room.state", event, room, previous));
	}
	applyRedaction(room, redaction, emits) {
		const target = redaction.redacts ?? redaction.content.redacts;
		if (typeof target !== "string") return;
		const event = room.timeline.find(target);
		if (!event) return;
		event.applyRedaction(redaction);
		const related = room.removeRelations(event);
		emits.push(() => this.emit("room.redaction", event, room, redaction));
		if (related) emits.push(() => this.emit("room.relation", related, event, room));
	}
	/** Index an event's relation; a server-bundled edit of it is decrypted along with it. */
	indexRelations(event, room, emits, toDecrypt) {
		const target = room.applyRelations(event);
		const bundled = room.bundledReplacement(event);
		if (bundled?.isEncrypted() && bundled.decryptionStatus === "pending") toDecrypt.push({
			event: bundled,
			room
		});
		if (relationOf(event)) emits.push(() => this.emit("room.relation", target, event, room));
	}
	applyEphemeral(room, ev, emits) {
		if (ev.type === "m.typing") {
			const ids = ev.content.user_ids;
			room.typing = Array.isArray(ids) ? ids.filter((x) => typeof x === "string") : [];
			emits.push(() => this.emit("room.typing", room, room.typing));
		} else if (ev.type === "m.receipt") {
			for (const [eventId, byType] of Object.entries(ev.content)) for (const [type, byUser] of Object.entries(byType ?? {})) {
				let m = room.receipts.get(type);
				if (!m) room.receipts.set(type, m = /* @__PURE__ */ new Map());
				for (const [userId, r] of Object.entries(byUser ?? {})) m.set(userId, {
					eventId,
					ts: r?.ts,
					threadId: r?.thread_id
				});
			}
			emits.push(() => this.emit("room.receipt", room, ev));
		}
	}
	persistRoom(tx, room) {
		tx.put("rooms", room.roomId, {
			membership: room.membership,
			summary: room.summary,
			unread: room.unreadNotifications,
			backToken: room.timeline.backToken,
			atStart: room.timeline.atStart,
			inviteState: room.inviteState,
			accountData: Object.fromEntries(room.accountData),
			membersLoaded: room.state.membersLoaded
		});
		const keep = this.opts.storedTimelineEvents ?? 50;
		const recent = room.timeline.events.filter((e) => e.eventId && !e.localStatus?.match(/sending|encrypting|failed/)).slice(-keep);
		tx.put("room_timeline", room.roomId, {
			events: recent.map((e) => e.wire),
			complete: recent.length === room.timeline.events.length
		});
	}
	async loadFromStore() {
		this.syncToken = await this.store.get("sync", "token");
		for (const [key, value] of await this.store.list("client", "account_data|")) this.accountData.set(key.slice(13), value);
		for (const [roomId, stored] of await this.store.list("rooms")) {
			const room = new Room(roomId, this.userId, stored.membership, { maxTimelineEvents: this.opts.maxTimelineEvents });
			room.summary = stored.summary ?? {};
			room.unreadNotifications = stored.unread ?? room.unreadNotifications;
			room.inviteState = stored.inviteState ?? [];
			for (const [k, v] of Object.entries(stored.accountData ?? {})) room.accountData.set(k, v);
			for (const [, raw] of await this.store.list("room_state", `${roomId}|`)) room.state.setRaw(raw);
			room.state.membersLoaded = stored.membersLoaded ?? false;
			const timeline = await this.store.get("room_timeline", roomId);
			for (const event of room.timeline.append((timeline?.events ?? []).map((raw) => new MatrixEvent(raw)))) room.applyRelations(event);
			room.timeline.backToken = timeline?.complete ? stored.backToken : void 0;
			room.timeline.atStart = timeline?.complete ? stored.atStart ?? false : false;
			this.rooms.set(roomId, room);
		}
		if (this.syncToken) this.logger.info("resuming from stored sync state", { rooms: this.rooms.size });
	}
	/** After start(): decrypt the stored timelines (plaintext is never stored). */
	async decryptStoredTimelines() {
		for (const room of this.rooms.values()) for (const event of room.timeline.events) if (event.isEncrypted() && event.decryptionStatus !== "decrypted") await this.decryptAndEmit(event, room);
	}
	async decryptAndEmit(event, room) {
		if (!this.e2ee) {
			event.setDecryptionFailed("MISSING_ROOM_KEY");
			return;
		}
		if (await this.e2ee.decryptRoomEvent(event)) {
			this.emit("event.decrypted", event, room);
			if (isVerificationEvent(event)) await this.routeVerification(event);
			if (!this.callQueue && event.type.startsWith("m.call.")) await this.calls.handleEvents([{
				event,
				room
			}]);
			const target = room.applyRelations(event);
			if (target) this.emit("room.relation", target, event, room);
			if (this.notifyOnDecrypt.has(event)) {
				this.notifyOnDecrypt.delete(event);
				this.notifyIfRulesSay(event, room);
			}
		} else if (event.decryptionError === "MISSING_ROOM_KEY" || event.decryptionError === "UNKNOWN_MESSAGE_INDEX") {
			const sessionId = event.wire.content.session_id;
			if (typeof sessionId !== "string") return;
			const key = `${room.roomId}|${sessionId}`;
			let set = this.awaitingKeys.get(key);
			if (!set) {
				this.awaitingKeys.set(key, set = /* @__PURE__ */ new Set());
				const e2ee = this.e2ee;
				setTimer(() => {
					if (this.running && this.awaitingKeys.has(key)) e2ee.keyMissing(event);
				}, KEY_WAIT_MS);
			}
			if (set.size < 500) set.add(event);
		}
	}
	async retryAwaiting(roomId, sessionId) {
		const key = `${roomId}|${sessionId}`;
		const events = this.awaitingKeys.get(key);
		const room = this.rooms.get(roomId);
		if (!events || !room) return;
		this.awaitingKeys.delete(key);
		for (const event of events) await this.decryptAndEmit(event, room);
	}
	async createRoom(opts = {}) {
		const initialState = [...opts.initialState ?? []];
		if (opts.encrypted) initialState.push({
			type: "m.room.encryption",
			state_key: "",
			content: { algorithm: "m.megolm.v1.aes-sha2" }
		});
		return (await this.api.endpoint("POST /v3/createRoom", {}, { body: {
			name: opts.name,
			topic: opts.topic,
			preset: opts.preset,
			visibility: opts.visibility,
			invite: opts.invite,
			is_direct: opts.isDirect,
			room_alias_name: opts.roomAliasName,
			room_version: opts.roomVersion,
			initial_state: initialState.length ? initialState.map((s) => ({
				state_key: "",
				...s
			})) : void 0,
			power_level_content_override: opts.powerLevelContentOverride,
			creation_content: opts.creationContent
		} })).room_id;
	}
	/**
	* Join a room. Accepting an invite that was sent as a direct chat (is_direct) also records the
	* room in m.direct, as the spec asks of the invitee's client.
	*/
	async joinRoom(roomIdOrAlias, opts = {}) {
		const invite = this.rooms.get(roomIdOrAlias)?.inviteState.find((e) => e.type === "m.room.member" && e.state_key === this.userId);
		const res = roomIdOrAlias.startsWith("!") && !opts.via?.length ? await this.api.endpoint("POST /v3/rooms/:roomId/join", { roomId: roomIdOrAlias }, { body: { reason: opts.reason } }) : await this.api.endpoint("POST /v3/join/:roomIdOrAlias", { roomIdOrAlias }, {
			query: {
				via: opts.via,
				server_name: opts.via
			},
			body: { reason: opts.reason }
		});
		if (invite?.content.is_direct === true && invite.sender) await this.markDirect(res.room_id, invite.sender).catch((e) => this.logger.warn("could not update m.direct", describeError(e)));
		return res.room_id;
	}
	/** The m.direct map: user ID → the rooms that are direct chats with them. */
	getDirectRooms() {
		const content = this.accountData.get("m.direct") ?? {};
		const out = {};
		for (const [userId, rooms] of Object.entries(content)) if (Array.isArray(rooms)) out[userId] = rooms.filter((r) => typeof r === "string");
		return out;
	}
	/** The direct chat with a user this user is in and the other user has not left, newest first. */
	findDirectRoom(userId) {
		return (this.getDirectRooms()[userId] ?? []).map((id) => this.rooms.get(id)).filter((r) => r !== void 0 && r.membership === "join").filter((r) => {
			const m = r.state.membership(userId);
			return m === "join" || m === "invite";
		}).sort((a, b) => (b.lastEvent()?.originServerTs ?? 0) - (a.lastEvent()?.originServerTs ?? 0))[0];
	}
	/** Start a direct chat (encrypted unless `encrypted: false`) and record it in m.direct. */
	async createDirectRoom(userId, opts = {}) {
		const roomId = await this.createRoom({
			isDirect: true,
			invite: [userId],
			preset: "trusted_private_chat",
			encrypted: opts.encrypted ?? true
		});
		await this.markDirect(roomId, userId);
		return roomId;
	}
	/**
	* Record (or with `direct: false`, remove) a room as a direct chat with `userId` in m.direct.
	* Read from the server first, so a change made on another device since the last sync is kept.
	*/
	async markDirect(roomId, userId, direct = true) {
		const current = await this.account.getAccountData("m.direct") ?? {};
		const next = {};
		for (const [u, rooms] of Object.entries(current)) if (Array.isArray(rooms)) next[u] = rooms.filter((r) => typeof r === "string" && r !== roomId);
		if (direct) next[userId] = [...next[userId] ?? [], roomId];
		for (const [u, rooms] of Object.entries(next)) if (rooms.length === 0) delete next[u];
		await this.account.setAccountData("m.direct", next);
		this.accountData.set("m.direct", next);
	}
	/**
	* Join the room an upgraded room points to (m.room.tombstone), through the server of whoever
	* upgraded it. Resolves with the new room's ID, or undefined when the room was not upgraded.
	*/
	async followUpgrade(roomId) {
		const room = this.rooms.get(roomId);
		const successor = room?.successor();
		if (!successor) return void 0;
		const sender = room.state.get("m.room.tombstone")?.sender;
		return this.joinRoom(successor.roomId, { via: sender ? [sender.slice(sender.indexOf(":") + 1)] : void 0 });
	}
	/** Ask to join a room whose join rule is `knock` (https://spec.matrix.org/v1.19/client-server-api/#knocking-on-rooms). */
	async knockRoom(roomIdOrAlias, opts = {}) {
		return (await this.api.endpoint("POST /v3/knock/:roomIdOrAlias", { roomIdOrAlias }, {
			query: {
				via: opts.via,
				server_name: opts.via
			},
			body: { reason: opts.reason }
		})).room_id;
	}
	/** The IDs of the rooms the user is joined to, from the server (getRooms has the synced ones). */
	async getJoinedRooms() {
		return (await this.api.endpoint("GET /v3/joined_rooms", {}, {})).joined_rooms ?? [];
	}
	/**
	* Upgrade a room to a new room version (https://spec.matrix.org/v1.19/client-server-api/#room-upgrades):
	* the server creates the replacement room and tombstones this one. Resolves with the new room's ID.
	*/
	async upgradeRoom(roomId, newVersion, opts = {}) {
		return (await this.api.endpoint("POST /v3/rooms/:roomId/upgrade", { roomId }, { body: {
			new_version: newVersion,
			additional_creators: opts.additionalCreators
		} })).replacement_room;
	}
	/** The rooms both this user and `userId` are joined to (all pages). */
	async getMutualRooms(userId) {
		const rooms = [];
		let from;
		for (let page = 0; page < 100; page++) {
			const res = await this.api.endpoint("GET /v1/mutual_rooms", {}, { query: {
				user_id: userId,
				from
			} });
			rooms.push(...res.joined ?? []);
			from = res.next_batch;
			if (!from) break;
		}
		return rooms;
	}
	async leaveRoom(roomId, reason) {
		await this.api.endpoint("POST /v3/rooms/:roomId/leave", { roomId }, { body: { reason } });
	}
	async forgetRoom(roomId) {
		await this.api.endpoint("POST /v3/rooms/:roomId/forget", { roomId }, { body: {} });
		this.rooms.delete(roomId);
		await this.store.transaction(async (tx) => {
			tx.delete("rooms", roomId);
			tx.delete("room_timeline", roomId);
			for (const [key] of await tx.list("room_state", `${roomId}|`)) tx.delete("room_state", key);
		});
	}
	async invite(roomId, userId, reason) {
		await this.api.endpoint("POST /v3/rooms/:roomId/invite", { roomId }, { body: {
			user_id: userId,
			reason
		} });
	}
	async kick(roomId, userId, reason) {
		await this.api.endpoint("POST /v3/rooms/:roomId/kick", { roomId }, { body: {
			user_id: userId,
			reason
		} });
	}
	async ban(roomId, userId, reason) {
		await this.api.endpoint("POST /v3/rooms/:roomId/ban", { roomId }, { body: {
			user_id: userId,
			reason
		} });
	}
	async unban(roomId, userId, reason) {
		await this.api.endpoint("POST /v3/rooms/:roomId/unban", { roomId }, { body: {
			user_id: userId,
			reason
		} });
	}
	/** Invite by email or phone number through an identity server (https://spec.matrix.org/v1.19/client-server-api/#third-party-invites). */
	async inviteThirdParty(roomId, invite) {
		await this.api.endpoint("POST /v3/rooms/:roomId/invite", { roomId }, { body: {
			id_server: invite.idServer,
			id_access_token: invite.idAccessToken,
			medium: invite.medium,
			address: invite.address
		} });
	}
	async sendStateEvent(roomId, type, content, stateKey = "") {
		return (await this.api.endpoint("PUT /v3/rooms/:roomId/state/:eventType/:stateKey", {
			roomId,
			eventType: type,
			stateKey
		}, { body: content })).event_id;
	}
	setRoomName(roomId, name) {
		return this.sendStateEvent(roomId, "m.room.name", { name });
	}
	setRoomTopic(roomId, topic) {
		return this.sendStateEvent(roomId, "m.room.topic", { topic });
	}
	setRoomAvatar(roomId, mxcUri, info) {
		return this.sendStateEvent(roomId, "m.room.avatar", {
			url: mxcUri,
			...info ? { info } : {}
		});
	}
	setJoinRule(roomId, content) {
		return this.sendStateEvent(roomId, "m.room.join_rules", content);
	}
	setHistoryVisibility(roomId, visibility) {
		return this.sendStateEvent(roomId, "m.room.history_visibility", { history_visibility: visibility });
	}
	setGuestAccess(roomId, access) {
		return this.sendStateEvent(roomId, "m.room.guest_access", { guest_access: access });
	}
	setCanonicalAlias(roomId, alias, altAliases) {
		return this.sendStateEvent(roomId, "m.room.canonical_alias", {
			alias,
			...altAliases ? { alt_aliases: altAliases } : {}
		});
	}
	setPinnedEvents(roomId, eventIds) {
		return this.sendStateEvent(roomId, "m.room.pinned_events", { pinned: eventIds });
	}
	/**
	* Set one user's power level (null resets it to users_default). Reads the current power levels
	* from the synced room state (or the server), so it must not race another change.
	*/
	async setPowerLevel(roomId, userId, level) {
		const current = this.rooms.get(roomId)?.state.get("m.room.power_levels")?.content ?? await this.fetchStateEvent(roomId, "m.room.power_levels") ?? {};
		const users = { ...current.users };
		if (level === null) delete users[userId];
		else users[userId] = level;
		return this.sendStateEvent(roomId, "m.room.power_levels", {
			...current,
			users
		});
	}
	/** A state event's content from the server; undefined when there is none. */
	async fetchStateEvent(roomId, type, stateKey = "") {
		try {
			return await this.api.endpoint("GET /v3/rooms/:roomId/state/:eventType/:stateKey", {
				roomId,
				eventType: type,
				stateKey
			}, {});
		} catch (e) {
			if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return void 0;
			throw e;
		}
	}
	/** The room's whole current state from the server. */
	async fetchRoomState(roomId) {
		return (await this.api.endpoint("GET /v3/rooms/:roomId/state", { roomId }, {})).map((raw) => new MatrixEvent({
			...raw,
			room_id: roomId
		}));
	}
	/** Members with their display names and avatars, as the server has them now. */
	async fetchJoinedMembers(roomId) {
		const res = await this.api.endpoint("GET /v3/rooms/:roomId/joined_members", { roomId }, {});
		const out = {};
		for (const [userId, m] of Object.entries(res.joined ?? {})) out[userId] = {
			displayName: m?.display_name ?? void 0,
			avatarUrl: m?.avatar_url ?? void 0
		};
		return out;
	}
	/** Member events from the server, optionally at an earlier point (`at`, a sync token) or by membership. */
	async fetchMembers(roomId, opts = {}) {
		return ((await this.api.endpoint("GET /v3/rooms/:roomId/members", { roomId }, { query: {
			at: opts.at,
			membership: opts.membership,
			not_membership: opts.notMembership
		} })).chunk ?? []).map((raw) => new MatrixEvent({
			...raw,
			room_id: roomId
		}));
	}
	/** Turn on encryption (it cannot be turned off again). */
	enableEncryption(roomId, opts = {}) {
		return this.sendStateEvent(roomId, "m.room.encryption", {
			algorithm: "m.megolm.v1.aes-sha2",
			...opts.rotationPeriodMs !== void 0 ? { rotation_period_ms: opts.rotationPeriodMs } : {},
			...opts.rotationPeriodMsgs !== void 0 ? { rotation_period_msgs: opts.rotationPeriodMsgs } : {}
		});
	}
	/** Fetch the full member list (with lazy loading, /sync only sends the members it needs). */
	async loadMembers(roomId) {
		const room = this.rooms.get(roomId);
		if (!room) throw new Error(`Unknown room ${roomId}`);
		const res = await this.api.endpoint("GET /v3/rooms/:roomId/members", { roomId }, {});
		const encryptedJoins = /* @__PURE__ */ new Set();
		const emits = [];
		await this.store.transaction(async (tx) => {
			for (const raw of res.chunk ?? []) {
				const known = room.state.get("m.room.member", raw.state_key ?? "");
				if (known && known.originServerTs !== void 0 && raw.origin_server_ts !== void 0 && known.originServerTs > raw.origin_server_ts) continue;
				this.applyState(tx, room, {
					...raw,
					room_id: roomId
				}, emits, encryptedJoins);
			}
			room.state.membersLoaded = true;
			if (this.e2ee && room.isEncrypted()) await this.e2ee.devices.track(tx, encryptedJoins);
			this.persistRoom(tx, room);
		});
		for (const emit of emits) emit();
	}
	/** Load up to `limit` older events into the room's timeline. Returns how many were added. */
	async paginateBackwards(roomId, limit = 30) {
		const room = this.rooms.get(roomId);
		if (!room) throw new Error(`Unknown room ${roomId}`);
		if (room.timeline.atStart) return 0;
		const res = await this.api.endpoint("GET /v3/rooms/:roomId/messages", { roomId }, { query: {
			dir: "b",
			from: room.timeline.backToken,
			limit,
			filter: JSON.stringify({ lazy_load_members: true })
		} });
		const emits = [];
		const encryptedJoins = /* @__PURE__ */ new Set();
		await this.store.transaction(async (tx) => {
			for (const raw of res.state ?? []) if (raw.type === "m.room.member" && !room.state.get("m.room.member", raw.state_key ?? "")) this.applyState(tx, room, {
				...raw,
				room_id: roomId
			}, emits, encryptedJoins);
		});
		const events = (res.chunk ?? []).map((raw) => new MatrixEvent({
			...raw,
			room_id: roomId
		}));
		const added = room.timeline.prepend(events, res.end && (res.chunk?.length ?? 0) > 0 ? res.end : void 0);
		const toDecrypt = [];
		for (const event of added) this.indexRelations(event, room, emits, toDecrypt);
		for (const emit of emits) emit();
		for (const { event } of toDecrypt) await this.decryptAndEmit(event, room);
		for (const event of added) {
			if (event.isEncrypted()) await this.decryptAndEmit(event, room);
			this.emit("room.timeline", event, room, { live: false });
		}
		return added.length;
	}
	/** One event from the server, decrypted when it is encrypted and its key is known. */
	async fetchEvent(roomId, eventId) {
		const raw = await this.api.endpoint("GET /v3/rooms/:roomId/event/:eventId", {
			roomId,
			eventId
		}, {});
		return this.fetched(raw, roomId);
	}
	/** An event with the events around it (to jump to a reply's target, a search result, a permalink). */
	async fetchContext(roomId, eventId, opts = {}) {
		const res = await this.api.endpoint("GET /v3/rooms/:roomId/context/:eventId", {
			roomId,
			eventId
		}, { query: {
			limit: opts.limit,
			filter: opts.filter ? JSON.stringify(opts.filter) : void 0
		} });
		return {
			event: res.event ? await this.fetched(res.event, roomId) : void 0,
			before: await Promise.all((res.events_before ?? []).map((e) => this.fetched(e, roomId))),
			after: await Promise.all((res.events_after ?? []).map((e) => this.fetched(e, roomId))),
			state: (res.state ?? []).map((e) => new MatrixEvent({
				...e,
				room_id: roomId
			})),
			start: res.start,
			end: res.end
		};
	}
	/**
	* The events that relate to an event (https://spec.matrix.org/v1.19/client-server-api/#relationship-types):
	* all of them, or of one relation type (m.annotation, m.replace, m.thread, m.reference) and
	* event type. `recurse` follows relations of relations (v1.10).
	*/
	async fetchRelations(roomId, eventId, opts = {}) {
		const query = {
			from: opts.from,
			to: opts.to,
			limit: opts.limit,
			dir: opts.dir,
			recurse: opts.recurse
		};
		const res = opts.relType === void 0 ? await this.api.endpoint("GET /v1/rooms/:roomId/relations/:eventId", {
			roomId,
			eventId
		}, { query }) : opts.eventType === void 0 ? await this.api.endpoint("GET /v1/rooms/:roomId/relations/:eventId/:relType", {
			roomId,
			eventId,
			relType: opts.relType
		}, { query }) : await this.api.endpoint("GET /v1/rooms/:roomId/relations/:eventId/:relType/:eventType", {
			roomId,
			eventId,
			relType: opts.relType,
			eventType: opts.eventType
		}, { query });
		return {
			events: await Promise.all((res.chunk ?? []).map((e) => this.fetched(e, roomId))),
			nextBatch: res.next_batch,
			prevBatch: res.prev_batch
		};
	}
	/** Thread roots of a room, newest activity first (https://spec.matrix.org/v1.19/client-server-api/#threads). */
	async fetchThreads(roomId, opts = {}) {
		const res = await this.api.endpoint("GET /v1/rooms/:roomId/threads", { roomId }, { query: {
			include: opts.include,
			limit: opts.limit,
			from: opts.from
		} });
		return {
			roots: await Promise.all((res.chunk ?? []).map((e) => this.fetched(e, roomId))),
			nextBatch: res.next_batch
		};
	}
	/** The event closest to a point in time, searching forwards or backwards (to jump to a date). */
	async timestampToEvent(roomId, ts, dir = "f") {
		const res = await this.api.endpoint("GET /v1/rooms/:roomId/timestamp_to_event", { roomId }, { query: {
			ts,
			dir
		} });
		return {
			eventId: res.event_id,
			originServerTs: res.origin_server_ts
		};
	}
	/**
	* Server-side search of room events (https://spec.matrix.org/v1.19/client-server-api/#server-side-search).
	* Encrypted events cannot be searched by the server.
	*/
	search(term, opts = {}) {
		return this.api.endpoint("POST /v3/search", {}, {
			query: { next_batch: opts.nextBatch },
			body: { search_categories: { room_events: {
				search_term: term,
				keys: opts.keys,
				filter: opts.filter,
				order_by: opts.orderBy,
				event_context: opts.context ? {
					before_limit: opts.context.beforeLimit,
					after_limit: opts.context.afterLimit,
					include_profile: opts.context.includeProfile
				} : void 0,
				include_state: opts.includeState,
				groupings: opts.groupBy ? { group_by: opts.groupBy.map((key) => ({ key })) } : void 0
			} } }
		});
	}
	/**
	* A room's state and latest messages without joining it (world-readable rooms;
	* https://spec.matrix.org/v1.19/client-server-api/#peeking).
	*/
	async peekRoom(roomId) {
		const res = await this.api.endpoint("GET /v3/rooms/:roomId/initialSync", { roomId }, {});
		return {
			state: (res.state ?? []).map((e) => new MatrixEvent({
				...e,
				room_id: roomId
			})),
			messages: (res.messages?.chunk ?? []).map((e) => new MatrixEvent({
				...e,
				room_id: roomId
			})),
			end: res.messages?.end
		};
	}
	/** New events of a peeked room after `from` (the `end` of peekRoom), waiting up to `timeoutMs`. */
	async peekEvents(roomId, from, timeoutMs = 3e4) {
		const res = await this.api.endpoint("GET /v3/events", {}, { query: {
			room_id: roomId,
			from,
			timeout: timeoutMs
		} });
		return {
			events: (res.chunk ?? []).map((e) => new MatrixEvent({
				...e,
				room_id: roomId
			})),
			end: res.end
		};
	}
	async fetched(raw, roomId) {
		const event = new MatrixEvent({
			...raw,
			room_id: roomId
		});
		if (event.isEncrypted()) {
			if (this.e2ee) await this.e2ee.decryptRoomEvent(event);
			else event.setDecryptionFailed("MISSING_ROOM_KEY");
		}
		return event;
	}
	/**
	* Send a room event. It appears in the room's timeline at once (a local echo with
	* `localStatus`), is encrypted when the room is, and is matched with its copy from /sync by
	* transaction ID. Resolves with the event ID.
	*
	* In an encrypted room, an event is never sent in the clear: without the E2EE engine, sending
	* fails.
	*/
	async sendEvent(roomId, type, content, opts = {}) {
		const room = this.rooms.get(roomId);
		const txnId = opts.txnId ?? this.makeTxnId();
		const echo = new MatrixEvent({
			type,
			content,
			sender: this.userId,
			room_id: roomId,
			origin_server_ts: Date.now(),
			unsigned: { transaction_id: txnId }
		});
		echo.txnId = txnId;
		echo.localStatus = "sending";
		if (room) {
			room.timeline.append([echo]);
			this.localEchoes.set(txnId, {
				event: echo,
				room
			});
			const target = room.applyRelations(echo);
			this.emit("room.localEcho", echo, room);
			if (target) this.emit("room.relation", target, echo, room);
		}
		try {
			return await this.sendPrepared(roomId, room, echo, type, content, txnId);
		} catch (e) {
			echo.localStatus = "failed";
			if (room) this.emit("room.localEcho", echo, room);
			throw e;
		}
	}
	/** Send a failed event again, with its transaction ID (the server deduplicates). */
	async resendEvent(event) {
		if (event.localStatus !== "failed" || !event.txnId || !event.roomId) throw new Error("Only a failed local event can be resent");
		const room = this.rooms.get(event.roomId);
		event.localStatus = "sending";
		if (room) this.emit("room.localEcho", event, room);
		try {
			return await this.sendPrepared(event.roomId, room, event, event.type, event.content, event.txnId);
		} catch (e) {
			event.localStatus = "failed";
			if (room) this.emit("room.localEcho", event, room);
			throw e;
		}
	}
	async sendPrepared(roomId, room, echo, type, content, txnId) {
		let sendType = type;
		let body = content;
		if (room?.isEncrypted() && type !== "m.room.encrypted") {
			if (!this.e2ee) throw new Error("The room is encrypted and end-to-end encryption is turned off");
			echo.localStatus = "encrypting";
			if (!room.state.membersLoaded) await this.loadMembers(roomId);
			const enc = room.state.get("m.room.encryption").content;
			body = { ...await this.e2ee.encryptRoomEvent({
				roomId,
				algorithm: enc.algorithm,
				rotationPeriodMs: enc.rotation_period_ms,
				rotationPeriodMsgs: enc.rotation_period_msgs,
				historyVisibility: room.state.get("m.room.history_visibility")?.content.history_visibility ?? "shared",
				members: room.encryptionTargets()
			}, type, content) };
			sendType = "m.room.encrypted";
			echo.localStatus = "sending";
		} else if (!room && type !== "m.room.encrypted") {
			if (await this.api.endpoint("GET /v3/rooms/:roomId/state/:eventType/:stateKey", {
				roomId,
				eventType: "m.room.encryption",
				stateKey: ""
			}, {}).then(() => true, (e) => {
				if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return false;
				throw e;
			})) throw new Error(`Room ${roomId} is encrypted and not synced yet: sync first`);
		}
		const res = await this.api.endpoint("PUT /v3/rooms/:roomId/send/:eventType/:txnId", {
			roomId,
			eventType: sendType,
			txnId
		}, { body });
		if (!("event_id" in res) || typeof res.event_id !== "string") throw new Error("The server did not return an event ID");
		if (!echo.eventId) echo.wire = {
			...echo.wire,
			event_id: res.event_id
		};
		room?.timeline.index(echo);
		if (echo.localStatus !== "sent") {
			echo.localStatus = "sent";
			if (room) this.emit("room.localEcho", echo, room);
		}
		return res.event_id;
	}
	sendMessage(roomId, content) {
		return this.sendEvent(roomId, "m.room.message", content);
	}
	sendText(roomId, body) {
		return this.sendMessage(roomId, {
			msgtype: "m.text",
			body
		});
	}
	/**
	* Upload a file and send it as an m.image, m.video, m.audio or m.file message. In an encrypted
	* room the file is encrypted first (the event carries `file`, not `url`), so the server never
	* sees it. `info` is sent as given (mimetype, size, w, h, duration, …); size and mimetype are
	* filled in when missing.
	*/
	async sendFile(roomId, data, opts) {
		const info = {
			mimetype: opts.contentType,
			size: data.length,
			...opts.info
		};
		const encrypted = this.rooms.get(roomId)?.isEncrypted() ?? await this.fetchStateEvent(roomId, "m.room.encryption") !== void 0;
		const content = {
			msgtype: opts.msgtype ?? "m.file",
			body: opts.body ?? opts.filename,
			filename: opts.filename,
			info
		};
		if (encrypted) content.file = await this.media.uploadEncrypted(data);
		else content.url = await this.media.upload(data, {
			contentType: opts.contentType,
			filename: opts.filename
		});
		return this.sendEvent(roomId, "m.room.message", content);
	}
	/**
	* Edit a message (https://spec.matrix.org/v1.19/client-server-api/#event-replacements). The
	* edit's top-level body is a "* …" fallback for clients without edits; `m.mentions` at the top
	* level holds only the users newly mentioned, so they are not pinged twice.
	*/
	async sendEdit(roomId, eventId, newContent) {
		const original = this.rooms.get(roomId)?.timeline.find(eventId) ?? await this.fetchEvent(roomId, eventId);
		const { "m.relates_to": _dropped, ...replacement } = newContent;
		const before = new Set(original.latestContent["m.mentions"]?.user_ids ?? []);
		const mentioned = (replacement["m.mentions"]?.user_ids ?? []).filter((u) => !before.has(u));
		return this.sendEvent(roomId, original.type, {
			...replacement,
			body: `* ${replacement.body}`,
			...typeof replacement.formatted_body === "string" ? { formatted_body: `* ${replacement.formatted_body}` } : {},
			"m.mentions": mentioned.length ? { user_ids: mentioned } : {},
			"m.new_content": replacement,
			"m.relates_to": {
				rel_type: "m.replace",
				event_id: eventId
			}
		});
	}
	/**
	* Reply to an event (rich replies, https://spec.matrix.org/v1.19/client-server-api/#rich-replies).
	* The replied-to sender is mentioned. A reply to an event in a thread stays in the thread.
	*/
	async sendReply(roomId, inReplyTo, content) {
		const target = this.rooms.get(roomId)?.timeline.find(inReplyTo) ?? await this.fetchEvent(roomId, inReplyTo).catch(() => void 0);
		const mentions = new Set(content["m.mentions"]?.user_ids ?? []);
		if (target?.sender && target.sender !== this.userId) mentions.add(target.sender);
		const thread = target?.threadRootId;
		return this.sendMessage(roomId, {
			...content,
			"m.mentions": {
				...content["m.mentions"],
				user_ids: [...mentions]
			},
			"m.relates_to": thread ? {
				rel_type: "m.thread",
				event_id: thread,
				is_falling_back: false,
				"m.in_reply_to": { event_id: inReplyTo }
			} : { "m.in_reply_to": { event_id: inReplyTo } }
		});
	}
	/**
	* Send a message in a thread (https://spec.matrix.org/v1.19/client-server-api/#threading). It
	* carries a fallback reply to the thread's latest event, for clients without threads.
	*/
	async sendThreadMessage(roomId, rootId, content) {
		const latest = this.rooms.get(roomId)?.threadSummary(rootId)?.latestEvent?.eventId ?? rootId;
		return this.sendMessage(roomId, {
			...content,
			"m.relates_to": {
				rel_type: "m.thread",
				event_id: rootId,
				is_falling_back: true,
				"m.in_reply_to": { event_id: latest }
			}
		});
	}
	/** Take back this user's reaction with `key` on an event (redacts the reaction). Resolves false if there was none. */
	async removeReaction(roomId, eventId, key) {
		const mine = this.rooms.get(roomId)?.reactions(eventId).find((g) => g.key === key)?.myEventId;
		if (!mine) return false;
		await this.redactEvent(roomId, mine);
		return true;
	}
	sendReaction(roomId, eventId, key) {
		return this.sendEvent(roomId, "m.reaction", { "m.relates_to": {
			rel_type: "m.annotation",
			event_id: eventId,
			key
		} });
	}
	async redactEvent(roomId, eventId, reason) {
		return (await this.api.endpoint("PUT /v3/rooms/:roomId/redact/:eventId/:txnId", {
			roomId,
			eventId,
			txnId: this.makeTxnId()
		}, { body: { reason } })).event_id;
	}
	/**
	* A read receipt (https://spec.matrix.org/v1.19/client-server-api/#receipts). `threadId` makes it
	* a threaded receipt: "main" for the main timeline, or a thread root's event ID.
	*/
	async sendReadReceipt(roomId, eventId, type = "m.read", opts = {}) {
		await this.api.endpoint("POST /v3/rooms/:roomId/receipt/:receiptType/:eventId", {
			roomId,
			receiptType: type,
			eventId
		}, { body: opts.threadId ? { thread_id: opts.threadId } : {} });
	}
	/** Move the fully-read marker and the read receipts in one request (https://spec.matrix.org/v1.19/client-server-api/#fully-read-markers). */
	async setReadMarkers(roomId, markers) {
		await this.api.endpoint("POST /v3/rooms/:roomId/read_markers", { roomId }, { body: {
			"m.fully_read": markers.fullyRead,
			"m.read": markers.read,
			"m.read.private": markers.readPrivate
		} });
	}
	async setTyping(roomId, typing, timeoutMs = 3e4) {
		await this.api.endpoint("PUT /v3/rooms/:roomId/typing/:userId", {
			roomId,
			userId: this.userId
		}, { body: typing ? {
			typing,
			timeout: timeoutMs
		} : { typing } });
	}
	/** Report content to the server's administrators (https://spec.matrix.org/v1.19/client-server-api/#reporting-content). */
	async reportEvent(roomId, eventId, reason) {
		await this.api.endpoint("POST /v3/rooms/:roomId/report/:eventId", {
			roomId,
			eventId
		}, { body: { reason } });
	}
	async reportRoom(roomId, reason) {
		await this.api.endpoint("POST /v3/rooms/:roomId/report", { roomId }, { body: { reason } });
	}
	async reportUser(userId, reason) {
		await this.api.endpoint("POST /v3/users/:userId/report", { userId }, { body: { reason } });
	}
	/** A room's tags from the server (the synced ones are in the room's m.tag account data). */
	async getTags(roomId) {
		return (await this.api.endpoint("GET /v3/user/:userId/rooms/:roomId/tags", {
			userId: this.userId,
			roomId
		}, {})).tags ?? {};
	}
	/** Tag a room: m.favourite, m.lowpriority, m.server_notice, or u.<anything>. `order` is in [0, 1]. */
	async setTag(roomId, tag, order) {
		await this.api.endpoint("PUT /v3/user/:userId/rooms/:roomId/tags/:tag", {
			userId: this.userId,
			roomId,
			tag
		}, { body: order === void 0 ? {} : { order } });
	}
	async deleteTag(roomId, tag) {
		await this.api.endpoint("DELETE /v3/user/:userId/rooms/:roomId/tags/:tag", {
			userId: this.userId,
			roomId,
			tag
		}, {});
	}
};
export { MatrixClient };

//# sourceMappingURL=client.js.map