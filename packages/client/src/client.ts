import { AccountApi } from "./account/account.ts";
import { AdminApi } from "./account/admin.ts";
import { DevicesApi } from "./account/devices.ts";
import { PresenceApi, ProfileApi } from "./account/profile.ts";
import { CredentialsTokenProvider } from "./auth/login.ts";
import type { Credentials, CredentialsStore, TokenProvider } from "./auth/types.ts";
import { nobleCryptoPrimitives } from "./crypto/noble.ts";
import type { CryptoPrimitives } from "./crypto/primitives.ts";
import { E2EEEngine, type ToDeviceOutcome } from "./e2ee/engine.ts";
import type { DecryptedToDevice } from "./e2ee/olm.ts";
import { fetchHttpAdapter, type HttpAdapter } from "./http/adapter.ts";
import { MatrixHttpApi } from "./http/api.ts";
import { ConnectionError, MatrixError } from "./http/errors.ts";
import { DirectoryApi } from "./directory/directory.ts";
import { MediaApi } from "./media/media.ts";
import { PushApi, type PushOutcome } from "./push/push.ts";
import { SpacesApi } from "./spaces/spaces.ts";
import type { PeerConnectionFactory } from "./voip/call.ts";
import { CallsApi } from "./voip/calls.ts";
import { MatrixEvent } from "./models/event.ts";
import { relationOf } from "./models/relations.ts";
import { Room } from "./models/room.ts";
import {
  type ClientEvent,
  type ContentOf,
  encodeBase64,
  type Membership,
  type PowerLevelsContent,
  type RoomEventFilter,
  type SearchResponse,
  type ToDeviceEvent,
} from "@katrix/shared";
import { isAbortError, newAbortController, setTimer, sleep, type AbortControllerLike } from "./platform.ts";
import { nativeE2EEProtocol } from "./protocol/native.ts";
import type { E2EEProtocol, PickleKey } from "./protocol/protocol.ts";
import type { StorageAdapter } from "./storage/adapter.ts";
import { MemoryStorage } from "./storage/memory.ts";
import { Store, type Transaction } from "./storage/store.ts";
import type { JoinedRoomUpdate, SyncResult, SyncTransport, TimelineUpdate } from "./sync/types.ts";
import { SyncV3Transport, type V3SyncOptions } from "./sync/v3.ts";
import { TypedEmitter } from "./util/emitter.ts";
import { describeError, noopLogger, type Logger } from "./util/logger.ts";

export interface ClientOptions {
  baseUrl: string;
  /** From a login (Auth.loginWithPassword, OAuth); refreshed automatically when it has a refresh token. */
  credentials?: Credentials;
  /** Or a token provider of your own (then userId and deviceId are required). */
  tokenProvider?: TokenProvider;
  userId?: string;
  deviceId?: string;
  /** Persist refreshed tokens. */
  credentialsStore?: CredentialsStore;
  http?: HttpAdapter;
  /** Default: in memory (state is lost when the app stops). */
  storage?: StorageAdapter;
  logger?: Logger;
  /** End-to-end encryption (on by default); false turns it off: encrypted rooms then cannot be written to. */
  e2ee?: false | { primitives?: CryptoPrimitives; protocol?: E2EEProtocol; pickleKey?: PickleKey };
  sync?: V3SyncOptions & { transport?: SyncTransport; pollTimeoutMs?: number; setPresence?: "online" | "offline" | "unavailable" };
  /** Voice and video calls: the app's WebRTC (RTCPeerConnection, or react-native-webrtc's). */
  calls?: { peerConnectionFactory?: PeerConnectionFactory };
  /** Events kept per room in memory (default 1000) and in storage (default 50). */
  maxTimelineEvents?: number;
  storedTimelineEvents?: number;
}

export type SyncState = "prepared" | "syncing" | "error" | "stopped";

export interface TimelineEventInfo {
  /** From /sync (live) or from back-pagination. */
  live: boolean;
}

export interface ClientEvents {
  sync: [state: SyncState, error?: unknown];
  room: [room: Room];
  "room.membership": [room: Room, membership: Membership, previous: Membership | undefined];
  "room.timeline": [event: MatrixEvent, room: Room, info: TimelineEventInfo];
  "room.state": [event: MatrixEvent, room: Room, previous: MatrixEvent | undefined];
  "room.localEcho": [event: MatrixEvent, room: Room];
  "room.redaction": [event: MatrixEvent, room: Room, redaction: ClientEvent];
  /**
   * An event's relations changed: an edit, a reaction or a thread reply arrived (or was
   * decrypted, or redacted). `target` is the event related to, when it is loaded.
   */
  "room.relation": [target: MatrixEvent | undefined, relation: MatrixEvent, room: Room];
  "room.typing": [room: Room, userIds: string[]];
  "room.receipt": [room: Room, event: ClientEvent];
  "room.accountData": [room: Room, event: ClientEvent];
  "event.decrypted": [event: MatrixEvent, room: Room];
  /**
   * A new event from someone else that the user's push rules say notifies, evaluated on the
   * client, so on the plaintext of encrypted events (once decrypted; also when its key arrives
   * later). Not emitted for the first sync's events.
   */
  notification: [event: MatrixEvent, room: Room, outcome: PushOutcome];
  accountData: [event: ClientEvent];
  toDevice: [event: ToDeviceEvent, decrypted?: DecryptedToDevice];
  presence: [event: ClientEvent];
  loggedOut: [error: MatrixError];
  /** Errors the client handled itself (a failed sync round, a listener that threw). */
  error: [error: unknown];
}

interface StoredRoom {
  membership: Membership;
  summary: Room["summary"];
  unread: Room["unreadNotifications"];
  backToken?: string;
  atStart?: boolean;
  inviteState: Room["inviteState"];
  accountData: Record<string, Record<string, unknown>>;
  membersLoaded: boolean;
}

const MAX_BACKOFF_MS = 30_000;

function isVerificationEvent(event: MatrixEvent): boolean {
  return (
    event.type.startsWith("m.key.verification.") ||
    (event.type === "m.room.message" && (event.content as { msgtype?: unknown }).msgtype === "m.key.verification.request")
  );
}
/** How long a missing room key may take to arrive before the backup and other devices are asked. */
const KEY_WAIT_MS = 5_000;

/**
 * A Matrix client: sync, rooms, timelines, sending, and end-to-end encryption.
 *
 * One /sync round is processed as one unit of work: its to-device messages (room keys, Olm
 * sessions, used one-time keys), device list changes, room updates and the new sync token are
 * stored together. A crash in between repeats the round instead of losing keys: to-device
 * messages are deleted on the server only once a sync with the next token is made.
 */
export class MatrixClient extends TypedEmitter<ClientEvents> {
  readonly api: MatrixHttpApi;
  readonly userId: string;
  readonly deviceId: string;
  readonly store: Store;
  readonly e2ee?: E2EEEngine;
  /** Password, deactivation, 3PIDs, account data, filters, ignored users, tokens. */
  readonly account: AccountApi;
  readonly devices: DevicesApi;
  readonly profile: ProfileApi;
  readonly presence: PresenceApi;
  /** Aliases, the public room directory, room summaries, the user directory, third-party networks. */
  readonly directory: DirectoryApi;
  readonly admin: AdminApi;
  /** Uploads, downloads, thumbnails, URL previews, encrypted attachments. */
  readonly media: MediaApi;
  /** Pushers, push rules, the notification list, and evaluating rules locally. */
  readonly push: PushApi;
  /** Creating spaces, their children and parents, the space hierarchy. */
  readonly spaces: SpacesApi;
  /** Voice and video calls (signalling; media through the app's WebRTC). */
  readonly calls: CallsApi;
  private readonly logger: Logger;
  private readonly primitives: CryptoPrimitives;
  private readonly transport: SyncTransport;
  private readonly opts: ClientOptions;
  private readonly tokens: TokenProvider;
  private readonly rooms = new Map<string, Room>();
  private syncToken?: string;
  private running = false;
  private syncAbort?: AbortControllerLike;
  private loop?: Promise<void>;
  private prepared = false;
  private txnCounter = 0;
  /** Encrypted events waiting for their room key, by `${roomId}|${sessionId}`. */
  private awaitingKeys = new Map<string, Set<MatrixEvent>>();
  /** Our events being sent, by transaction ID, to match the copy that comes down /sync. */
  private localEchoes = new Map<string, { event: MatrixEvent; room: Room }>();
  private accountData = new Map<string, Record<string, unknown>>();
  private started?: Promise<void>;
  private loaded = false;
  /** During a sync round after the first: the new events from others, to evaluate push rules on. */
  private notifyQueue?: Array<{ event: MatrixEvent; room: Room }>;
  /** During a sync round: the new live events, for the m.call.* among them once decrypted. */
  private callQueue?: Array<{ event: MatrixEvent; room: Room }>;
  /** Encrypted events still to be evaluated once decrypted. */
  private notifyOnDecrypt = new WeakSet<MatrixEvent>();

  constructor(opts: ClientOptions) {
    super();
    this.opts = opts;
    this.logger = opts.logger ?? noopLogger;
    this.onListenerError = (event, e) => {
      this.logger.error("an event listener threw", { event: String(event), ...describeError(e) });
      if (event !== "error") this.emit("error", e);
    };
    const http = opts.http ?? fetchHttpAdapter();
    const userId = opts.credentials?.userId ?? opts.userId;
    const deviceId = opts.credentials?.deviceId ?? opts.deviceId;
    if (!userId || !deviceId) throw new Error("A client needs credentials, or userId and deviceId with a token provider");
    this.userId = userId;
    this.deviceId = deviceId;
    this.tokens =
      opts.tokenProvider ??
      (opts.credentials
        ? new CredentialsTokenProvider({ credentials: opts.credentials, baseUrl: opts.baseUrl, http, store: opts.credentialsStore })
        : (() => {
            throw new Error("A client needs credentials or a token provider");
          })());
    this.api = new MatrixHttpApi({ baseUrl: opts.baseUrl, http, tokens: this.tokens, logger: this.logger });
    this.store = new Store(opts.storage ?? new MemoryStorage());
    this.account = new AccountApi(this.api, userId);
    this.devices = new DevicesApi(this.api);
    this.profile = new ProfileApi(this.api, userId);
    this.presence = new PresenceApi(this.api, userId);
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
      makeId: () => encodeBase64(this.primitives.randomBytes(12), { urlSafe: true }),
    });
    const e2ee = opts.e2ee === false ? undefined : (opts.e2ee ?? {});
    this.primitives = e2ee?.primitives ?? nobleCryptoPrimitives();
    this.media = new MediaApi(this.api, this.primitives);
    if (e2ee) {
      this.e2ee = new E2EEEngine({
        api: this.api,
        primitives: this.primitives,
        accountData: {
          // Synced account data when there is some, else the server's (secret storage is read
          // before the first sync when a device is set up).
          get: async (type) => this.accountData.get(type) ?? (await this.account.getAccountData(type)),
          set: async (type, content) => {
            await this.account.setAccountData(type, content);
            this.accountData.set(type, content);
          },
        },
        sendRoomEvent: (roomId, type, content) => this.sendEvent(roomId, type, content),
        store: this.store,
        protocol: e2ee.protocol ?? nativeE2EEProtocol(this.primitives),
        pickleKey: e2ee.pickleKey,
        logger: this.logger,
        userId,
        deviceId,
        txnId: () => this.makeTxnId(),
      });
    }
    this.transport = opts.sync?.transport ?? new SyncV3Transport(this.api, opts.sync);
    if (this.e2ee)
      this.e2ee.onNewSessions = (sessions) => {
        for (const s of sessions) void this.retryAwaiting(s.roomId, s.sessionId);
      };
  }

  /** A transaction ID unique for this device (random, so restarts never reuse one). */
  makeTxnId(): string {
    return `m${Date.now().toString(36)}.${(this.txnCounter++).toString(36)}.${encodeBase64(this.primitives.randomBytes(6), { urlSafe: true })}`;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getRooms(): Room[] {
    return [...this.rooms.values()];
  }

  getAccountData(type: string): Record<string, unknown> | undefined {
    return this.accountData.get(type);
  }

  isPrepared(): boolean {
    return this.prepared;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Load stored state, set up encryption, and start syncing. Resolves once the loop runs. */
  start(): Promise<void> {
    if (!this.started) {
      this.started = (async () => {
        // Once per instance: after stop() and start() the rooms the app holds stay the same objects.
        if (!this.loaded) await this.loadFromStore();
        this.loaded = true;
        await this.e2ee?.init();
        await this.decryptStoredTimelines();
        this.running = true;
        this.loop = this.syncLoop();
      })();
    }
    return this.started;
  }

  /** Stop syncing (in-flight sends finish). */
  async stop(): Promise<void> {
    this.running = false;
    this.syncAbort?.abort();
    await this.loop?.catch(() => {});
    this.loop = undefined;
    this.started = undefined;
    this.emit("sync", "stopped");
  }

  /** Resolves after the first sync round has been processed (immediately if it has). */
  async waitForPrepared(): Promise<void> {
    if (this.prepared) return;
    await this.waitFor("sync", (s) => s === "prepared");
  }

  /** Log out on the server and stop. */
  async logout(): Promise<void> {
    await this.stop();
    await this.api.endpoint("POST /v3/logout", {}, { body: {} });
  }

  async close(): Promise<void> {
    await this.stop();
    await this.store.close();
  }

  private async syncLoop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      this.syncAbort = newAbortController();
      try {
        const result = await this.transport.sync({
          since: this.syncToken,
          timeoutMs: this.syncToken ? (this.opts.sync?.pollTimeoutMs ?? 30_000) : 0,
          signal: this.syncAbort.signal,
          setPresence: this.opts.sync?.setPresence,
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
        if (!(e instanceof ConnectionError || e instanceof MatrixError))
          this.logger.error("processing a sync response failed", describeError(e));
        else this.logger.warn("sync failed, retrying", { wait, ...describeError(e) });
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

  // ─── Sync processing ──────────────────────────────────────────────────────

  /** Apply one sync result: crypto and rooms in one unit of work, then events and decryption. */
  async processSync(result: SyncResult): Promise<void> {
    const emits: Array<() => void> = [];
    const toDecrypt: Array<{ event: MatrixEvent; room: Room }> = [];
    const encryptedJoins = new Set<string>();
    let outcome: ToDeviceOutcome = { events: result.toDevice.map((event) => ({ event })), newSessions: [], wedged: [] };
    const notifyQueue: Array<{ event: MatrixEvent; room: Room }> = [];
    this.notifyQueue = this.prepared ? notifyQueue : undefined;
    const callQueue: Array<{ event: MatrixEvent; room: Room }> = [];
    this.callQueue = callQueue;

    await this.store.transaction(async (tx) => {
      if (this.e2ee) outcome = await this.e2ee.processSync(tx, result);
      for (const ev of result.accountData) {
        if (typeof ev.type !== "string") continue;
        this.accountData.set(ev.type, ev.content as Record<string, unknown>);
        tx.put("client", `account_data|${ev.type}`, ev.content);
        emits.push(() => this.emit("accountData", ev));
      }
      for (const [roomId, update] of Object.entries(result.rooms.join))
        this.applyJoined(tx, roomId, update, emits, toDecrypt, encryptedJoins);
      for (const [roomId, update] of Object.entries(result.rooms.invite))
        this.applyInvite(tx, roomId, "invite", update.strippedState, emits);
      for (const [roomId, update] of Object.entries(result.rooms.knock)) this.applyInvite(tx, roomId, "knock", update.strippedState, emits);
      for (const [roomId, update] of Object.entries(result.rooms.leave)) {
        const room = this.roomFor(roomId, "leave", emits);
        this.setMembership(room, "leave", emits);
        this.applyStateAndTimeline(tx, room, update.state, update.timeline, false, emits, toDecrypt, encryptedJoins);
        this.persistRoom(tx, room);
      }
      if (this.e2ee && encryptedJoins.size > 0) await this.e2ee.devices.track(tx, encryptedJoins);
      tx.put("sync", "token", result.nextBatch);
    });
    this.notifyQueue = undefined;
    this.syncToken = result.nextBatch;

    for (const emit of emits) emit();
    for (const { event, decrypted } of outcome.events) {
      this.emit("toDevice", event, decrypted);
      if (this.e2ee && event.type.startsWith("m.key.verification."))
        await this.e2ee.verification
          .handleToDevice(event)
          .catch((e) => this.logger.warn("a verification message failed", describeError(e)));
    }
    for (const ev of result.presence) this.emit("presence", ev);

    if (this.e2ee) {
      await this.e2ee.afterSync(result, outcome);
      // Know the senders' devices before decrypting, so events are attributed to them.
      if (encryptedJoins.size > 0)
        await this.e2ee.devices.refresh([...encryptedJoins]).catch((e) => this.logger.warn("device query failed", describeError(e)));
      for (const { event, room } of toDecrypt) await this.decryptAndEmit(event, room);
      for (const s of outcome.newSessions) await this.retryAwaiting(s.roomId, s.sessionId);
    }
    this.callQueue = undefined;
    const callEvents = callQueue.filter(({ event }) => event.type.startsWith("m.call."));
    if (callEvents.length) await this.calls.handleEvents(callEvents);
    for (const { event, room } of notifyQueue) {
      if (event.isEncrypted() && event.decryptionStatus !== "decrypted") this.notifyOnDecrypt.add(event);
      else this.notifyIfRulesSay(event, room);
    }
  }

  private async routeVerification(event: MatrixEvent): Promise<void> {
    await this.e2ee?.verification.handleRoomEvent(event).catch((e) => this.logger.warn("a verification event failed", describeError(e)));
  }

  private notifyIfRulesSay(event: MatrixEvent, room: Room): void {
    const outcome = this.push.evaluate(event, room);
    if (outcome.notify) this.emit("notification", event, room, outcome);
  }

  /**
   * Unread counts. For an unencrypted room they are the server's. For an encrypted room the
   * server can only count every encrypted message, so they are counted here, on the decrypted
   * events after the user's latest receipt (their own messages count as read): `exact` is false
   * when that receipt is older than the timeline in memory, and the count is a lower bound then.
   */
  getUnreadCounts(roomId: string): { notification: number; highlight: number; exact: boolean } {
    const room = this.rooms.get(roomId);
    if (!room) return { notification: 0, highlight: 0, exact: true };
    if (!room.isEncrypted()) return { ...room.unreadNotifications, exact: true };
    const read = new Set([room.readReceipt(this.userId, "m.read")?.eventId, room.readReceipt(this.userId, "m.read.private")?.eventId]);
    let notification = 0;
    let highlight = 0;
    const events = room.timeline.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if ((e.eventId && read.has(e.eventId)) || e.sender === this.userId) return { notification, highlight, exact: true };
      if (e.isEncrypted() && e.decryptionStatus !== "decrypted") continue;
      const outcome = this.push.evaluate(e, room);
      if (outcome.notify) notification++;
      if (outcome.notify && outcome.highlight) highlight++;
    }
    return { notification, highlight, exact: room.timeline.atStart };
  }

  private roomFor(roomId: string, membership: Membership, emits: Array<() => void>): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId, this.userId, membership, { maxTimelineEvents: this.opts.maxTimelineEvents });
      this.rooms.set(roomId, room);
      const r = room;
      emits.push(() => this.emit("room", r));
      emits.push(() => this.emit("room.membership", r, membership, undefined));
    }
    return room;
  }

  private setMembership(room: Room, membership: Membership, emits: Array<() => void>): void {
    const previous = room.membership;
    if (previous === membership) return;
    room.membership = membership;
    emits.push(() => this.emit("room.membership", room, membership, previous));
  }

  private applyInvite(
    tx: Transaction,
    roomId: string,
    membership: "invite" | "knock",
    stripped: Room["inviteState"],
    emits: Array<() => void>,
  ): void {
    const room = this.roomFor(roomId, membership, emits);
    this.setMembership(room, membership, emits);
    room.inviteState = stripped.filter((e) => typeof e?.type === "string");
    this.persistRoom(tx, room);
  }

  private applyJoined(
    tx: Transaction,
    roomId: string,
    update: JoinedRoomUpdate,
    emits: Array<() => void>,
    toDecrypt: Array<{ event: MatrixEvent; room: Room }>,
    encryptedJoins: Set<string>,
  ): void {
    const room = this.roomFor(roomId, "join", emits);
    this.setMembership(room, "join", emits);
    room.inviteState = [];
    if (update.summary) {
      room.summary = {
        heroes: update.summary.heroes?.length ? update.summary.heroes : room.summary.heroes,
        joinedMemberCount: update.summary.joinedMemberCount ?? room.summary.joinedMemberCount,
        invitedMemberCount: update.summary.invitedMemberCount ?? room.summary.invitedMemberCount,
      };
    }
    if (update.unreadNotifications) {
      room.unreadNotifications = {
        highlight: update.unreadNotifications.highlight_count ?? room.unreadNotifications.highlight,
        notification: update.unreadNotifications.notification_count ?? room.unreadNotifications.notification,
      };
    }
    this.applyStateAndTimeline(tx, room, update.state, update.timeline, update.initial === true, emits, toDecrypt, encryptedJoins);
    for (const ev of update.ephemeral) this.applyEphemeral(room, ev, emits);
    for (const ev of update.accountData) {
      if (typeof ev.type !== "string") continue;
      room.accountData.set(ev.type, ev.content as Record<string, unknown>);
      emits.push(() => this.emit("room.accountData", room, ev));
    }
    this.persistRoom(tx, room);
  }

  private applyStateAndTimeline(
    tx: Transaction,
    room: Room,
    state: ClientEvent[],
    timeline: TimelineUpdate,
    replaceState: boolean,
    emits: Array<() => void>,
    toDecrypt: Array<{ event: MatrixEvent; room: Room }>,
    encryptedJoins: Set<string>,
  ): void {
    if (replaceState && state.length > 0 && room.state.all().length > 0) {
      for (const old of room.state.all()) tx.delete("room_state", `${room.roomId}|${old.wire.type}|${old.stateKey}`);
      room.state.clear();
    }
    for (const raw of state) this.applyState(tx, room, { ...raw, room_id: room.roomId }, emits, encryptedJoins);
    if (timeline.limited) room.timeline.reset(timeline.prevBatch);
    else if (room.timeline.events.length === 0 && room.timeline.backToken === undefined) room.timeline.backToken = timeline.prevBatch;

    const fresh: MatrixEvent[] = [];
    for (const raw of timeline.events) {
      const wire = { ...raw, room_id: room.roomId } as ClientEvent;
      // Our own event coming back: it replaces its local echo instead of appearing twice.
      const txnId = wire.unsigned?.transaction_id;
      const echo = typeof txnId === "string" && wire.sender === this.userId ? this.localEchoes.get(txnId) : undefined;
      if (echo && echo.room === room) {
        const clear = { type: echo.event.type as string, content: echo.event.content as Record<string, unknown> };
        const wasClear = !echo.event.isEncrypted();
        echo.event.wire = wire;
        // We know what we encrypted: the echo keeps showing it.
        if (wasClear && wire.type === "m.room.encrypted" && this.e2ee) {
          echo.event.setDecrypted(clear, {
            senderCurve25519Key: this.e2ee.identityKeys.curve25519,
            claimedEd25519Key: this.e2ee.identityKeys.ed25519,
            senderDeviceId: this.deviceId,
            authenticity: "authenticated",
          });
        }
        echo.event.localStatus = "sent";
        room.timeline.index(echo.event);
        this.localEchoes.delete(txnId!);
        if (wire.state_key !== undefined) this.applyState(tx, room, wire, emits, encryptedJoins);
        continue;
      }
      const known = wire.event_id ? room.timeline.find(wire.event_id) : undefined;
      if (known) {
        // Seen in a round whose unit of work did not commit: it was never decrypted.
        if (known.isEncrypted() && known.decryptionStatus === "pending") toDecrypt.push({ event: known, room });
        continue;
      }
      const event = new MatrixEvent(wire);
      if (wire.state_key !== undefined) this.applyState(tx, room, wire, emits, encryptedJoins);
      if (wire.type === "m.room.redaction") this.applyRedaction(room, wire, emits);
      fresh.push(event);
    }
    for (const event of room.timeline.append(fresh)) {
      this.indexRelations(event, room, emits, toDecrypt);
      if (event.isEncrypted()) toDecrypt.push({ event, room });
      if (this.notifyQueue && room.membership === "join" && event.sender !== this.userId) this.notifyQueue.push({ event, room });
      if (this.callQueue && room.membership === "join") this.callQueue.push({ event, room });
      if (!event.isEncrypted() && this.e2ee && isVerificationEvent(event)) emits.push(() => void this.routeVerification(event));
      emits.push(() => this.emit("room.timeline", event, room, { live: true }));
    }
  }

  private applyState(tx: Transaction, room: Room, raw: ClientEvent, emits: Array<() => void>, encryptedJoins: Set<string>): void {
    if (typeof raw.type !== "string" || typeof raw.state_key !== "string") return;
    const event = new MatrixEvent(raw);
    const previous = room.state.set(event);
    tx.put("room_state", `${room.roomId}|${raw.type}|${raw.state_key}`, raw);
    if (raw.type === "m.room.member" && room.isEncrypted()) {
      const m = (raw.content as ContentOf<"m.room.member">).membership;
      if (m === "join" || m === "invite") encryptedJoins.add(raw.state_key);
    }
    // A room that turns encrypted: everyone in it is now someone we encrypt for.
    if (raw.type === "m.room.encryption")
      for (const m of room.state.members()) if (m.membership === "join" || m.membership === "invite") encryptedJoins.add(m.userId);
    emits.push(() => this.emit("room.state", event, room, previous));
  }

  private applyRedaction(room: Room, redaction: ClientEvent, emits: Array<() => void>): void {
    const target = redaction.redacts ?? (redaction.content as { redacts?: string }).redacts;
    if (typeof target !== "string") return;
    const event = room.timeline.find(target);
    if (!event) return;
    event.applyRedaction(redaction);
    const related = room.removeRelations(event);
    emits.push(() => this.emit("room.redaction", event, room, redaction));
    if (related) emits.push(() => this.emit("room.relation", related, event, room));
  }

  /** Index an event's relation; a server-bundled edit of it is decrypted along with it. */
  private indexRelations(
    event: MatrixEvent,
    room: Room,
    emits: Array<() => void>,
    toDecrypt: Array<{ event: MatrixEvent; room: Room }>,
  ): void {
    const target = room.applyRelations(event);
    const bundled = room.bundledReplacement(event);
    if (bundled?.isEncrypted() && bundled.decryptionStatus === "pending") toDecrypt.push({ event: bundled, room });
    if (relationOf(event)) emits.push(() => this.emit("room.relation", target, event, room));
  }

  private applyEphemeral(room: Room, ev: ClientEvent, emits: Array<() => void>): void {
    if (ev.type === "m.typing") {
      const ids = (ev.content as { user_ids?: unknown }).user_ids;
      room.typing = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
      emits.push(() => this.emit("room.typing", room, room.typing));
    } else if (ev.type === "m.receipt") {
      for (const [eventId, byType] of Object.entries(
        ev.content as Record<string, Record<string, Record<string, { ts?: number; thread_id?: string }>>>,
      )) {
        for (const [type, byUser] of Object.entries(byType ?? {})) {
          let m = room.receipts.get(type);
          if (!m) room.receipts.set(type, (m = new Map()));
          for (const [userId, r] of Object.entries(byUser ?? {})) m.set(userId, { eventId, ts: r?.ts, threadId: r?.thread_id });
        }
      }
      emits.push(() => this.emit("room.receipt", room, ev));
    }
  }

  private persistRoom(tx: Transaction, room: Room): void {
    tx.put("rooms", room.roomId, {
      membership: room.membership,
      summary: room.summary,
      unread: room.unreadNotifications,
      backToken: room.timeline.backToken,
      atStart: room.timeline.atStart,
      inviteState: room.inviteState,
      accountData: Object.fromEntries(room.accountData),
      membersLoaded: room.state.membersLoaded,
    } satisfies StoredRoom);
    // The recent timeline as the server sent it: encrypted events stay encrypted at rest.
    const keep = this.opts.storedTimelineEvents ?? 50;
    const recent = room.timeline.events.filter((e) => e.eventId && !e.localStatus?.match(/sending|encrypting|failed/)).slice(-keep);
    tx.put("room_timeline", room.roomId, { events: recent.map((e) => e.wire), complete: recent.length === room.timeline.events.length });
  }

  private async loadFromStore(): Promise<void> {
    this.syncToken = await this.store.get<string>("sync", "token");
    for (const [key, value] of await this.store.list<Record<string, unknown>>("client", "account_data|"))
      this.accountData.set(key.slice("account_data|".length), value);
    for (const [roomId, stored] of await this.store.list<StoredRoom>("rooms")) {
      const room = new Room(roomId, this.userId, stored.membership, { maxTimelineEvents: this.opts.maxTimelineEvents });
      room.summary = stored.summary ?? {};
      room.unreadNotifications = stored.unread ?? room.unreadNotifications;
      room.inviteState = stored.inviteState ?? [];
      for (const [k, v] of Object.entries(stored.accountData ?? {})) room.accountData.set(k, v);
      for (const [, raw] of await this.store.list<ClientEvent>("room_state", `${roomId}|`)) room.state.setRaw(raw);
      room.state.membersLoaded = stored.membersLoaded ?? false;
      const timeline = await this.store.get<{ events: ClientEvent[]; complete: boolean }>("room_timeline", roomId);
      for (const event of room.timeline.append((timeline?.events ?? []).map((raw) => new MatrixEvent(raw)))) room.applyRelations(event);
      // The stored tail starts after the back token only if the whole segment was kept.
      room.timeline.backToken = timeline?.complete ? stored.backToken : undefined;
      room.timeline.atStart = timeline?.complete ? (stored.atStart ?? false) : false;
      this.rooms.set(roomId, room);
    }
    if (this.syncToken) this.logger.info("resuming from stored sync state", { rooms: this.rooms.size });
  }

  /** After start(): decrypt the stored timelines (plaintext is never stored). */
  async decryptStoredTimelines(): Promise<void> {
    for (const room of this.rooms.values())
      for (const event of room.timeline.events)
        if (event.isEncrypted() && event.decryptionStatus !== "decrypted") await this.decryptAndEmit(event, room);
  }

  private async decryptAndEmit(event: MatrixEvent, room: Room): Promise<void> {
    if (!this.e2ee) {
      event.setDecryptionFailed("MISSING_ROOM_KEY");
      return;
    }
    if (await this.e2ee.decryptRoomEvent(event)) {
      this.emit("event.decrypted", event, room);
      if (isVerificationEvent(event)) await this.routeVerification(event);
      // A call event decrypted outside a sync round (its key came late).
      if (!this.callQueue && event.type.startsWith("m.call.")) await this.calls.handleEvents([{ event, room }]);
      // Edits and reactions count once decrypted (their type and m.new_content are inside).
      const target = room.applyRelations(event);
      if (target) this.emit("room.relation", target, event, room);
      if (this.notifyOnDecrypt.has(event)) {
        this.notifyOnDecrypt.delete(event);
        this.notifyIfRulesSay(event, room);
      }
    } else if (event.decryptionError === "MISSING_ROOM_KEY" || event.decryptionError === "UNKNOWN_MESSAGE_INDEX") {
      const sessionId = (event.wire.content as { session_id?: unknown }).session_id;
      if (typeof sessionId !== "string") return;
      const key = `${room.roomId}|${sessionId}`;
      let set = this.awaitingKeys.get(key);
      if (!set) {
        this.awaitingKeys.set(key, (set = new Set()));
        // The first event of a session without its key: if the key has not come a few seconds
        // later (it is usually on its way, in the same or the next sync), look in the backup and
        // ask our other devices.
        const e2ee = this.e2ee;
        setTimer(() => {
          if (this.running && this.awaitingKeys.has(key)) void e2ee.keyMissing(event);
        }, KEY_WAIT_MS);
      }
      // Bounded: events that never get a key do not pile up forever.
      if (set.size < 500) set.add(event);
    }
  }

  private async retryAwaiting(roomId: string, sessionId: string): Promise<void> {
    const key = `${roomId}|${sessionId}`;
    const events = this.awaitingKeys.get(key);
    const room = this.rooms.get(roomId);
    if (!events || !room) return;
    this.awaitingKeys.delete(key);
    for (const event of events) await this.decryptAndEmit(event, room);
  }

  // ─── Rooms ────────────────────────────────────────────────────────────────

  async createRoom(
    opts: {
      name?: string;
      topic?: string;
      preset?: "private_chat" | "public_chat" | "trusted_private_chat";
      visibility?: "public" | "private";
      invite?: string[];
      isDirect?: boolean;
      roomAliasName?: string;
      roomVersion?: string;
      /** Turn on end-to-end encryption from the start (m.room.encryption in initial_state). */
      encrypted?: boolean;
      initialState?: Array<{ type: string; state_key?: string; content: Record<string, unknown> }>;
      powerLevelContentOverride?: Record<string, unknown>;
      creationContent?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const initialState = [...(opts.initialState ?? [])];
    if (opts.encrypted) initialState.push({ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } });
    const res = await this.api.endpoint(
      "POST /v3/createRoom",
      {},
      {
        body: {
          name: opts.name,
          topic: opts.topic,
          preset: opts.preset,
          visibility: opts.visibility,
          invite: opts.invite,
          is_direct: opts.isDirect,
          room_alias_name: opts.roomAliasName,
          room_version: opts.roomVersion,
          initial_state: initialState.length ? initialState.map((s) => ({ state_key: "", ...s })) : undefined,
          power_level_content_override: opts.powerLevelContentOverride,
          creation_content: opts.creationContent,
        },
      },
    );
    return res.room_id;
  }

  /**
   * Join a room. Accepting an invite that was sent as a direct chat (is_direct) also records the
   * room in m.direct, as the spec asks of the invitee's client.
   */
  async joinRoom(roomIdOrAlias: string, opts: { via?: string[]; reason?: string } = {}): Promise<string> {
    const invite = this.rooms.get(roomIdOrAlias)?.inviteState.find((e) => e.type === "m.room.member" && e.state_key === this.userId);
    const res = await this.api.endpoint(
      "POST /v3/join/:roomIdOrAlias",
      { roomIdOrAlias },
      {
        query: { via: opts.via, server_name: opts.via },
        body: { reason: opts.reason },
      },
    );
    if (invite?.content.is_direct === true && invite.sender)
      await this.markDirect(res.room_id, invite.sender).catch((e) => this.logger.warn("could not update m.direct", describeError(e)));
    return res.room_id;
  }

  // ─── Direct chats (https://spec.matrix.org/v1.19/client-server-api/#direct-messaging) ──

  /** The m.direct map: user ID → the rooms that are direct chats with them. */
  getDirectRooms(): Record<string, string[]> {
    const content = this.accountData.get("m.direct") ?? {};
    const out: Record<string, string[]> = {};
    for (const [userId, rooms] of Object.entries(content))
      if (Array.isArray(rooms)) out[userId] = rooms.filter((r): r is string => typeof r === "string");
    return out;
  }

  /** The direct chat with a user this user is in and the other user has not left, newest first. */
  findDirectRoom(userId: string): Room | undefined {
    const candidates = (this.getDirectRooms()[userId] ?? [])
      .map((id) => this.rooms.get(id))
      .filter((r): r is Room => r !== undefined && r.membership === "join")
      .filter((r) => {
        const m = r.state.membership(userId);
        return m === "join" || m === "invite";
      });
    return candidates.sort((a, b) => (b.lastEvent()?.originServerTs ?? 0) - (a.lastEvent()?.originServerTs ?? 0))[0];
  }

  /** Start a direct chat (encrypted unless `encrypted: false`) and record it in m.direct. */
  async createDirectRoom(userId: string, opts: { encrypted?: boolean } = {}): Promise<string> {
    const roomId = await this.createRoom({
      isDirect: true,
      invite: [userId],
      preset: "trusted_private_chat",
      encrypted: opts.encrypted ?? true,
    });
    await this.markDirect(roomId, userId);
    return roomId;
  }

  /**
   * Record (or with `direct: false`, remove) a room as a direct chat with `userId` in m.direct.
   * Read from the server first, so a change made on another device since the last sync is kept.
   */
  async markDirect(roomId: string, userId: string, direct = true): Promise<void> {
    const current = ((await this.account.getAccountData("m.direct")) ?? {}) as Record<string, unknown>;
    const next: Record<string, string[]> = {};
    for (const [u, rooms] of Object.entries(current))
      if (Array.isArray(rooms)) next[u] = rooms.filter((r): r is string => typeof r === "string" && r !== roomId);
    if (direct) next[userId] = [...(next[userId] ?? []), roomId];
    for (const [u, rooms] of Object.entries(next)) if (rooms.length === 0) delete next[u];
    await this.account.setAccountData("m.direct", next);
    this.accountData.set("m.direct", next);
  }

  /**
   * Join the room an upgraded room points to (m.room.tombstone), through the server of whoever
   * upgraded it. Resolves with the new room's ID, or undefined when the room was not upgraded.
   */
  async followUpgrade(roomId: string): Promise<string | undefined> {
    const room = this.rooms.get(roomId);
    const successor = room?.successor();
    if (!successor) return undefined;
    const sender = room!.state.get("m.room.tombstone")?.sender;
    return this.joinRoom(successor.roomId, { via: sender ? [sender.slice(sender.indexOf(":") + 1)] : undefined });
  }

  /** Ask to join a room whose join rule is `knock` (https://spec.matrix.org/v1.19/client-server-api/#knocking-on-rooms). */
  async knockRoom(roomIdOrAlias: string, opts: { via?: string[]; reason?: string } = {}): Promise<string> {
    const res = await this.api.endpoint(
      "POST /v3/knock/:roomIdOrAlias",
      { roomIdOrAlias },
      { query: { via: opts.via, server_name: opts.via }, body: { reason: opts.reason } },
    );
    return res.room_id;
  }

  /** The IDs of the rooms the user is joined to, from the server (getRooms has the synced ones). */
  async getJoinedRooms(): Promise<string[]> {
    return (await this.api.endpoint("GET /v3/joined_rooms", {}, {})).joined_rooms ?? [];
  }

  /**
   * Upgrade a room to a new room version (https://spec.matrix.org/v1.19/client-server-api/#room-upgrades):
   * the server creates the replacement room and tombstones this one. Resolves with the new room's ID.
   */
  async upgradeRoom(roomId: string, newVersion: string, opts: { additionalCreators?: string[] } = {}): Promise<string> {
    const res = await this.api.endpoint(
      "POST /v3/rooms/:roomId/upgrade",
      { roomId },
      { body: { new_version: newVersion, additional_creators: opts.additionalCreators } },
    );
    return res.replacement_room;
  }

  /** The rooms both this user and `userId` are joined to (all pages). */
  async getMutualRooms(userId: string): Promise<string[]> {
    const rooms: string[] = [];
    let from: string | undefined;
    // Bounded, in case a server keeps returning a next_batch.
    for (let page = 0; page < 100; page++) {
      const res = await this.api.endpoint("GET /v1/mutual_rooms", {}, { query: { user_id: userId, from } });
      rooms.push(...(res.joined ?? []));
      from = res.next_batch;
      if (!from) break;
    }
    return rooms;
  }

  async leaveRoom(roomId: string, reason?: string): Promise<void> {
    await this.api.endpoint("POST /v3/rooms/:roomId/leave", { roomId }, { body: { reason } });
  }

  async forgetRoom(roomId: string): Promise<void> {
    await this.api.endpoint("POST /v3/rooms/:roomId/forget", { roomId }, { body: {} });
    this.rooms.delete(roomId);
    await this.store.transaction(async (tx) => {
      tx.delete("rooms", roomId);
      tx.delete("room_timeline", roomId);
      for (const [key] of await tx.list("room_state", `${roomId}|`)) tx.delete("room_state", key);
    });
  }

  async invite(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.api.endpoint("POST /v3/rooms/:roomId/invite", { roomId }, { body: { user_id: userId, reason } });
  }

  async kick(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.api.endpoint("POST /v3/rooms/:roomId/kick", { roomId }, { body: { user_id: userId, reason } });
  }

  async ban(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.api.endpoint("POST /v3/rooms/:roomId/ban", { roomId }, { body: { user_id: userId, reason } });
  }

  async unban(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.api.endpoint("POST /v3/rooms/:roomId/unban", { roomId }, { body: { user_id: userId, reason } });
  }

  /** Invite by email or phone number through an identity server (https://spec.matrix.org/v1.19/client-server-api/#third-party-invites). */
  async inviteThirdParty(
    roomId: string,
    invite: { idServer: string; idAccessToken: string; medium: string; address: string },
  ): Promise<void> {
    await this.api.endpoint(
      "POST /v3/rooms/:roomId/invite",
      { roomId },
      { body: { id_server: invite.idServer, id_access_token: invite.idAccessToken, medium: invite.medium, address: invite.address } },
    );
  }

  async sendStateEvent<T extends string>(roomId: string, type: T, content: ContentOf<T>, stateKey = ""): Promise<string> {
    const res = await this.api.endpoint(
      "PUT /v3/rooms/:roomId/state/:eventType/:stateKey",
      { roomId, eventType: type, stateKey },
      { body: content as Record<string, unknown> },
    );
    return res.event_id;
  }

  setRoomName(roomId: string, name: string): Promise<string> {
    return this.sendStateEvent(roomId, "m.room.name", { name });
  }

  setRoomTopic(roomId: string, topic: string): Promise<string> {
    return this.sendStateEvent(roomId, "m.room.topic", { topic });
  }

  setRoomAvatar(roomId: string, mxcUri: string, info?: Record<string, unknown>): Promise<string> {
    return this.sendStateEvent(roomId, "m.room.avatar", { url: mxcUri, ...(info ? { info } : {}) });
  }

  setJoinRule(roomId: string, content: ContentOf<"m.room.join_rules">): Promise<string> {
    return this.sendStateEvent(roomId, "m.room.join_rules", content);
  }

  setHistoryVisibility(roomId: string, visibility: ContentOf<"m.room.history_visibility">["history_visibility"]): Promise<string> {
    return this.sendStateEvent(roomId, "m.room.history_visibility", { history_visibility: visibility });
  }

  setGuestAccess(roomId: string, access: ContentOf<"m.room.guest_access">["guest_access"]): Promise<string> {
    return this.sendStateEvent(roomId, "m.room.guest_access", { guest_access: access });
  }

  setCanonicalAlias(roomId: string, alias: string | null, altAliases?: string[]): Promise<string> {
    return this.sendStateEvent(roomId, "m.room.canonical_alias", { alias, ...(altAliases ? { alt_aliases: altAliases } : {}) });
  }

  setPinnedEvents(roomId: string, eventIds: string[]): Promise<string> {
    return this.sendStateEvent(roomId, "m.room.pinned_events", { pinned: eventIds });
  }

  /**
   * Set one user's power level (null resets it to users_default). Reads the current power levels
   * from the synced room state (or the server), so it must not race another change.
   */
  async setPowerLevel(roomId: string, userId: string, level: number | null): Promise<string> {
    const current =
      (this.rooms.get(roomId)?.state.get("m.room.power_levels")?.content as PowerLevelsContent | undefined) ??
      ((await this.fetchStateEvent(roomId, "m.room.power_levels")) as PowerLevelsContent | undefined) ??
      {};
    const users = { ...current.users };
    if (level === null) delete users[userId];
    else users[userId] = level;
    return this.sendStateEvent(roomId, "m.room.power_levels", { ...current, users });
  }

  /** A state event's content from the server; undefined when there is none. */
  async fetchStateEvent(roomId: string, type: string, stateKey = ""): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.api.endpoint("GET /v3/rooms/:roomId/state/:eventType/:stateKey", { roomId, eventType: type, stateKey }, {});
    } catch (e) {
      if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return undefined;
      throw e;
    }
  }

  /** The room's whole current state from the server. */
  async fetchRoomState(roomId: string): Promise<MatrixEvent[]> {
    const events = await this.api.endpoint("GET /v3/rooms/:roomId/state", { roomId }, {});
    return events.map((raw) => new MatrixEvent({ ...raw, room_id: roomId }));
  }

  /** Members with their display names and avatars, as the server has them now. */
  async fetchJoinedMembers(roomId: string): Promise<Record<string, { displayName?: string; avatarUrl?: string }>> {
    const res = await this.api.endpoint("GET /v3/rooms/:roomId/joined_members", { roomId }, {});
    const out: Record<string, { displayName?: string; avatarUrl?: string }> = {};
    for (const [userId, m] of Object.entries(res.joined ?? {}))
      out[userId] = { displayName: m?.display_name ?? undefined, avatarUrl: m?.avatar_url ?? undefined };
    return out;
  }

  /** Member events from the server, optionally at an earlier point (`at`, a sync token) or by membership. */
  async fetchMembers(
    roomId: string,
    opts: { at?: string; membership?: Membership; notMembership?: Membership } = {},
  ): Promise<MatrixEvent[]> {
    const res = await this.api.endpoint(
      "GET /v3/rooms/:roomId/members",
      { roomId },
      { query: { at: opts.at, membership: opts.membership, not_membership: opts.notMembership } },
    );
    return (res.chunk ?? []).map((raw) => new MatrixEvent({ ...raw, room_id: roomId }));
  }

  /** Turn on encryption (it cannot be turned off again). */
  enableEncryption(roomId: string, opts: { rotationPeriodMs?: number; rotationPeriodMsgs?: number } = {}): Promise<string> {
    return this.sendStateEvent(roomId, "m.room.encryption", {
      algorithm: "m.megolm.v1.aes-sha2",
      ...(opts.rotationPeriodMs !== undefined ? { rotation_period_ms: opts.rotationPeriodMs } : {}),
      ...(opts.rotationPeriodMsgs !== undefined ? { rotation_period_msgs: opts.rotationPeriodMsgs } : {}),
    });
  }

  /** Fetch the full member list (with lazy loading, /sync only sends the members it needs). */
  async loadMembers(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Unknown room ${roomId}`);
    const res = await this.api.endpoint("GET /v3/rooms/:roomId/members", { roomId }, {});
    const encryptedJoins = new Set<string>();
    const emits: Array<() => void> = [];
    await this.store.transaction(async (tx) => {
      for (const raw of res.chunk ?? []) {
        // A newer member event from /sync wins over the list.
        const known = room.state.get("m.room.member", raw.state_key ?? "");
        if (
          known &&
          known.originServerTs !== undefined &&
          raw.origin_server_ts !== undefined &&
          known.originServerTs > raw.origin_server_ts
        )
          continue;
        this.applyState(tx, room, { ...raw, room_id: roomId }, emits, encryptedJoins);
      }
      room.state.membersLoaded = true;
      if (this.e2ee && room.isEncrypted()) await this.e2ee.devices.track(tx, encryptedJoins);
      this.persistRoom(tx, room);
    });
    for (const emit of emits) emit();
  }

  // ─── Timeline ─────────────────────────────────────────────────────────────

  /** Load up to `limit` older events into the room's timeline. Returns how many were added. */
  async paginateBackwards(roomId: string, limit = 30): Promise<number> {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Unknown room ${roomId}`);
    if (room.timeline.atStart) return 0;
    const res = await this.api.endpoint(
      "GET /v3/rooms/:roomId/messages",
      { roomId },
      {
        query: { dir: "b", from: room.timeline.backToken, limit, filter: JSON.stringify({ lazy_load_members: true }) },
      },
    );
    const emits: Array<() => void> = [];
    const encryptedJoins = new Set<string>();
    // Members needed to show the older events; current state is not rewound.
    await this.store.transaction(async (tx) => {
      for (const raw of res.state ?? [])
        if (raw.type === "m.room.member" && !room.state.get("m.room.member", raw.state_key ?? ""))
          this.applyState(tx, room, { ...raw, room_id: roomId }, emits, encryptedJoins);
    });
    const events = (res.chunk ?? []).map((raw) => new MatrixEvent({ ...raw, room_id: roomId }));
    const added = room.timeline.prepend(events, res.end && (res.chunk?.length ?? 0) > 0 ? res.end : undefined);
    const toDecrypt: Array<{ event: MatrixEvent; room: Room }> = [];
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
  async fetchEvent(roomId: string, eventId: string): Promise<MatrixEvent> {
    const raw = await this.api.endpoint("GET /v3/rooms/:roomId/event/:eventId", { roomId, eventId }, {});
    return this.fetched(raw, roomId);
  }

  /** An event with the events around it (to jump to a reply's target, a search result, a permalink). */
  async fetchContext(
    roomId: string,
    eventId: string,
    opts: { limit?: number; filter?: RoomEventFilter } = {},
  ): Promise<{ event?: MatrixEvent; before: MatrixEvent[]; after: MatrixEvent[]; state: MatrixEvent[]; start?: string; end?: string }> {
    const res = await this.api.endpoint(
      "GET /v3/rooms/:roomId/context/:eventId",
      { roomId, eventId },
      { query: { limit: opts.limit, filter: opts.filter ? JSON.stringify(opts.filter) : undefined } },
    );
    return {
      event: res.event ? await this.fetched(res.event, roomId) : undefined,
      before: await Promise.all((res.events_before ?? []).map((e) => this.fetched(e, roomId))),
      after: await Promise.all((res.events_after ?? []).map((e) => this.fetched(e, roomId))),
      state: (res.state ?? []).map((e) => new MatrixEvent({ ...e, room_id: roomId })),
      start: res.start,
      end: res.end,
    };
  }

  /**
   * The events that relate to an event (https://spec.matrix.org/v1.19/client-server-api/#relationship-types):
   * all of them, or of one relation type (m.annotation, m.replace, m.thread, m.reference) and
   * event type. `recurse` follows relations of relations (v1.10).
   */
  async fetchRelations(
    roomId: string,
    eventId: string,
    opts: { relType?: string; eventType?: string; from?: string; to?: string; limit?: number; dir?: "b" | "f"; recurse?: boolean } = {},
  ): Promise<{ events: MatrixEvent[]; nextBatch?: string; prevBatch?: string }> {
    const query = { from: opts.from, to: opts.to, limit: opts.limit, dir: opts.dir, recurse: opts.recurse };
    const res =
      opts.relType === undefined
        ? await this.api.endpoint("GET /v1/rooms/:roomId/relations/:eventId", { roomId, eventId }, { query })
        : opts.eventType === undefined
          ? await this.api.endpoint(
              "GET /v1/rooms/:roomId/relations/:eventId/:relType",
              { roomId, eventId, relType: opts.relType },
              { query },
            )
          : await this.api.endpoint(
              "GET /v1/rooms/:roomId/relations/:eventId/:relType/:eventType",
              { roomId, eventId, relType: opts.relType, eventType: opts.eventType },
              { query },
            );
    return {
      events: await Promise.all((res.chunk ?? []).map((e) => this.fetched(e, roomId))),
      nextBatch: res.next_batch,
      prevBatch: res.prev_batch,
    };
  }

  /** Thread roots of a room, newest activity first (https://spec.matrix.org/v1.19/client-server-api/#threads). */
  async fetchThreads(
    roomId: string,
    opts: { include?: "all" | "participated"; limit?: number; from?: string } = {},
  ): Promise<{ roots: MatrixEvent[]; nextBatch?: string }> {
    const res = await this.api.endpoint(
      "GET /v1/rooms/:roomId/threads",
      { roomId },
      { query: { include: opts.include, limit: opts.limit, from: opts.from } },
    );
    return { roots: await Promise.all((res.chunk ?? []).map((e) => this.fetched(e, roomId))), nextBatch: res.next_batch };
  }

  /** The event closest to a point in time, searching forwards or backwards (to jump to a date). */
  async timestampToEvent(roomId: string, ts: number, dir: "f" | "b" = "f"): Promise<{ eventId: string; originServerTs: number }> {
    const res = await this.api.endpoint("GET /v1/rooms/:roomId/timestamp_to_event", { roomId }, { query: { ts, dir } });
    return { eventId: res.event_id, originServerTs: res.origin_server_ts };
  }

  /**
   * Server-side search of room events (https://spec.matrix.org/v1.19/client-server-api/#server-side-search).
   * Encrypted events cannot be searched by the server.
   */
  search(
    term: string,
    opts: {
      keys?: Array<"content.body" | "content.name" | "content.topic">;
      filter?: RoomEventFilter;
      orderBy?: "recent" | "rank";
      context?: { beforeLimit?: number; afterLimit?: number; includeProfile?: boolean };
      includeState?: boolean;
      groupBy?: Array<"room_id" | "sender">;
      nextBatch?: string;
    } = {},
  ): Promise<SearchResponse> {
    return this.api.endpoint(
      "POST /v3/search",
      {},
      {
        query: { next_batch: opts.nextBatch },
        body: {
          search_categories: {
            room_events: {
              search_term: term,
              keys: opts.keys,
              filter: opts.filter,
              order_by: opts.orderBy,
              event_context: opts.context
                ? {
                    before_limit: opts.context.beforeLimit,
                    after_limit: opts.context.afterLimit,
                    include_profile: opts.context.includeProfile,
                  }
                : undefined,
              include_state: opts.includeState,
              groupings: opts.groupBy ? { group_by: opts.groupBy.map((key) => ({ key })) } : undefined,
            },
          },
        },
      },
    );
  }

  /**
   * A room's state and latest messages without joining it (world-readable rooms;
   * https://spec.matrix.org/v1.19/client-server-api/#peeking).
   */
  async peekRoom(roomId: string): Promise<{ state: MatrixEvent[]; messages: MatrixEvent[]; end?: string }> {
    const res = await this.api.endpoint("GET /v3/rooms/:roomId/initialSync", { roomId }, {});
    return {
      state: (res.state ?? []).map((e) => new MatrixEvent({ ...e, room_id: roomId })),
      messages: (res.messages?.chunk ?? []).map((e) => new MatrixEvent({ ...e, room_id: roomId })),
      end: res.messages?.end,
    };
  }

  /** New events of a peeked room after `from` (the `end` of peekRoom), waiting up to `timeoutMs`. */
  async peekEvents(roomId: string, from?: string, timeoutMs = 30_000): Promise<{ events: MatrixEvent[]; end?: string }> {
    const res = await this.api.endpoint("GET /v3/events", {}, { query: { room_id: roomId, from, timeout: timeoutMs } });
    return { events: (res.chunk ?? []).map((e) => new MatrixEvent({ ...e, room_id: roomId })), end: res.end };
  }

  private async fetched(raw: ClientEvent, roomId: string): Promise<MatrixEvent> {
    const event = new MatrixEvent({ ...raw, room_id: roomId });
    if (event.isEncrypted()) {
      if (this.e2ee) await this.e2ee.decryptRoomEvent(event);
      else event.setDecryptionFailed("MISSING_ROOM_KEY");
    }
    return event;
  }

  // ─── Sending ──────────────────────────────────────────────────────────────

  /**
   * Send a room event. It appears in the room's timeline at once (a local echo with
   * `localStatus`), is encrypted when the room is, and is matched with its copy from /sync by
   * transaction ID. Resolves with the event ID.
   *
   * In an encrypted room, an event is never sent in the clear: without the E2EE engine, sending
   * fails.
   */
  async sendEvent<T extends string>(roomId: string, type: T, content: ContentOf<T>, opts: { txnId?: string } = {}): Promise<string> {
    const room = this.rooms.get(roomId);
    const txnId = opts.txnId ?? this.makeTxnId();
    const echo = new MatrixEvent({
      type,
      content: content as Record<string, unknown>,
      sender: this.userId,
      room_id: roomId,
      origin_server_ts: Date.now(),
      unsigned: { transaction_id: txnId },
    });
    echo.txnId = txnId;
    echo.localStatus = "sending";
    if (room) {
      room.timeline.append([echo]);
      this.localEchoes.set(txnId, { event: echo, room });
      const target = room.applyRelations(echo);
      this.emit("room.localEcho", echo, room);
      if (target) this.emit("room.relation", target, echo, room);
    }
    try {
      return await this.sendPrepared(roomId, room, echo, type, content as Record<string, unknown>, txnId);
    } catch (e) {
      echo.localStatus = "failed";
      if (room) this.emit("room.localEcho", echo, room);
      throw e;
    }
  }

  /** Send a failed event again, with its transaction ID (the server deduplicates). */
  async resendEvent(event: MatrixEvent): Promise<string> {
    if (event.localStatus !== "failed" || !event.txnId || !event.roomId) throw new Error("Only a failed local event can be resent");
    const room = this.rooms.get(event.roomId);
    event.localStatus = "sending";
    if (room) this.emit("room.localEcho", event, room);
    try {
      return await this.sendPrepared(event.roomId, room, event, event.type, event.content as Record<string, unknown>, event.txnId);
    } catch (e) {
      event.localStatus = "failed";
      if (room) this.emit("room.localEcho", event, room);
      throw e;
    }
  }

  private async sendPrepared(
    roomId: string,
    room: Room | undefined,
    echo: MatrixEvent,
    type: string,
    content: Record<string, unknown>,
    txnId: string,
  ): Promise<string> {
    let sendType = type;
    let body: Record<string, unknown> = content;
    if (room?.isEncrypted() && type !== "m.room.encrypted") {
      if (!this.e2ee) throw new Error("The room is encrypted and end-to-end encryption is turned off");
      echo.localStatus = "encrypting";
      if (!room.state.membersLoaded) await this.loadMembers(roomId);
      const enc = room.state.get("m.room.encryption")!.content;
      body = (await this.e2ee.encryptRoomEvent(
        {
          roomId,
          algorithm: enc.algorithm,
          rotationPeriodMs: enc.rotation_period_ms,
          rotationPeriodMsgs: enc.rotation_period_msgs,
          historyVisibility: room.state.get("m.room.history_visibility")?.content.history_visibility ?? "shared",
          members: room.encryptionTargets(),
        },
        type,
        content,
      )) as unknown as Record<string, unknown>;
      sendType = "m.room.encrypted";
      echo.localStatus = "sending";
    } else if (!room && type !== "m.room.encrypted") {
      // A room not synced (yet): ask the server whether it is encrypted rather than risk sending
      // in the clear. Encrypting needs its members and settings, so that waits for the sync.
      const encrypted = await this.api
        .endpoint("GET /v3/rooms/:roomId/state/:eventType/:stateKey", { roomId, eventType: "m.room.encryption", stateKey: "" }, {})
        .then(
          () => true,
          (e) => {
            if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return false;
            throw e;
          },
        );
      if (encrypted) throw new Error(`Room ${roomId} is encrypted and not synced yet: sync first`);
    }
    const res = await this.api.endpoint("PUT /v3/rooms/:roomId/send/:eventType/:txnId", { roomId, eventType: sendType, txnId }, { body });
    // A delay_id comes only for delayed sends (MSC4140), which this method never asks for.
    if (!("event_id" in res) || typeof res.event_id !== "string") throw new Error("The server did not return an event ID");
    if (!echo.eventId) echo.wire = { ...echo.wire, event_id: res.event_id };
    room?.timeline.index(echo);
    if (echo.localStatus !== "sent") {
      echo.localStatus = "sent";
      if (room) this.emit("room.localEcho", echo, room);
    }
    return res.event_id;
  }

  sendMessage(roomId: string, content: ContentOf<"m.room.message">): Promise<string> {
    return this.sendEvent(roomId, "m.room.message", content);
  }

  sendText(roomId: string, body: string): Promise<string> {
    return this.sendMessage(roomId, { msgtype: "m.text", body });
  }

  /**
   * Upload a file and send it as an m.image, m.video, m.audio or m.file message. In an encrypted
   * room the file is encrypted first (the event carries `file`, not `url`), so the server never
   * sees it. `info` is sent as given (mimetype, size, w, h, duration, …); size and mimetype are
   * filled in when missing.
   */
  async sendFile(
    roomId: string,
    data: Uint8Array,
    opts: {
      msgtype?: "m.image" | "m.video" | "m.audio" | "m.file";
      filename: string;
      contentType?: string;
      body?: string;
      info?: Record<string, unknown>;
    },
  ): Promise<string> {
    const info = { mimetype: opts.contentType, size: data.length, ...opts.info };
    const encrypted = this.rooms.get(roomId)?.isEncrypted() ?? (await this.fetchStateEvent(roomId, "m.room.encryption")) !== undefined;
    const content: Record<string, unknown> = {
      msgtype: opts.msgtype ?? "m.file",
      body: opts.body ?? opts.filename,
      filename: opts.filename,
      info,
    };
    if (encrypted) content.file = await this.media.uploadEncrypted(data);
    else content.url = await this.media.upload(data, { contentType: opts.contentType, filename: opts.filename });
    return this.sendEvent(roomId, "m.room.message", content as ContentOf<"m.room.message">);
  }

  /**
   * Edit a message (https://spec.matrix.org/v1.19/client-server-api/#event-replacements). The
   * edit's top-level body is a "* …" fallback for clients without edits; `m.mentions` at the top
   * level holds only the users newly mentioned, so they are not pinged twice.
   */
  async sendEdit(roomId: string, eventId: string, newContent: ContentOf<"m.room.message">): Promise<string> {
    const original = this.rooms.get(roomId)?.timeline.find(eventId) ?? (await this.fetchEvent(roomId, eventId));
    const { "m.relates_to": _dropped, ...replacement } = newContent as ContentOf<"m.room.message"> & { "m.relates_to"?: unknown };
    const before = new Set((original.latestContent as { "m.mentions"?: { user_ids?: string[] } })["m.mentions"]?.user_ids ?? []);
    const mentioned = (replacement["m.mentions"]?.user_ids ?? []).filter((u) => !before.has(u));
    return this.sendEvent(roomId, original.type, {
      ...replacement,
      body: `* ${replacement.body}`,
      ...(typeof replacement.formatted_body === "string" ? { formatted_body: `* ${replacement.formatted_body}` } : {}),
      "m.mentions": mentioned.length ? { user_ids: mentioned } : {},
      "m.new_content": replacement,
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    } as Record<string, unknown>);
  }

  /**
   * Reply to an event (rich replies, https://spec.matrix.org/v1.19/client-server-api/#rich-replies).
   * The replied-to sender is mentioned. A reply to an event in a thread stays in the thread.
   */
  async sendReply(roomId: string, inReplyTo: string, content: ContentOf<"m.room.message">): Promise<string> {
    const target = this.rooms.get(roomId)?.timeline.find(inReplyTo) ?? (await this.fetchEvent(roomId, inReplyTo).catch(() => undefined));
    const mentions = new Set(content["m.mentions"]?.user_ids ?? []);
    if (target?.sender && target.sender !== this.userId) mentions.add(target.sender);
    const thread = target?.threadRootId;
    return this.sendMessage(roomId, {
      ...content,
      "m.mentions": { ...content["m.mentions"], user_ids: [...mentions] },
      "m.relates_to": thread
        ? { rel_type: "m.thread", event_id: thread, is_falling_back: false, "m.in_reply_to": { event_id: inReplyTo } }
        : { "m.in_reply_to": { event_id: inReplyTo } },
    });
  }

  /**
   * Send a message in a thread (https://spec.matrix.org/v1.19/client-server-api/#threading). It
   * carries a fallback reply to the thread's latest event, for clients without threads.
   */
  async sendThreadMessage(roomId: string, rootId: string, content: ContentOf<"m.room.message">): Promise<string> {
    const room = this.rooms.get(roomId);
    const latest = room?.threadSummary(rootId)?.latestEvent?.eventId ?? rootId;
    return this.sendMessage(roomId, {
      ...content,
      "m.relates_to": { rel_type: "m.thread", event_id: rootId, is_falling_back: true, "m.in_reply_to": { event_id: latest } },
    });
  }

  /** Take back this user's reaction with `key` on an event (redacts the reaction). Resolves false if there was none. */
  async removeReaction(roomId: string, eventId: string, key: string): Promise<boolean> {
    const mine = this.rooms
      .get(roomId)
      ?.reactions(eventId)
      .find((g) => g.key === key)?.myEventId;
    if (!mine) return false;
    await this.redactEvent(roomId, mine);
    return true;
  }

  sendReaction(roomId: string, eventId: string, key: string): Promise<string> {
    return this.sendEvent(roomId, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key } });
  }

  async redactEvent(roomId: string, eventId: string, reason?: string): Promise<string> {
    const res = await this.api.endpoint(
      "PUT /v3/rooms/:roomId/redact/:eventId/:txnId",
      { roomId, eventId, txnId: this.makeTxnId() },
      {
        body: { reason },
      },
    );
    return res.event_id;
  }

  /**
   * A read receipt (https://spec.matrix.org/v1.19/client-server-api/#receipts). `threadId` makes it
   * a threaded receipt: "main" for the main timeline, or a thread root's event ID.
   */
  async sendReadReceipt(
    roomId: string,
    eventId: string,
    type: "m.read" | "m.read.private" | "m.fully_read" = "m.read",
    opts: { threadId?: string } = {},
  ): Promise<void> {
    await this.api.endpoint(
      "POST /v3/rooms/:roomId/receipt/:receiptType/:eventId",
      { roomId, receiptType: type, eventId },
      { body: opts.threadId ? { thread_id: opts.threadId } : {} },
    );
  }

  /** Move the fully-read marker and the read receipts in one request (https://spec.matrix.org/v1.19/client-server-api/#fully-read-markers). */
  async setReadMarkers(roomId: string, markers: { fullyRead?: string; read?: string; readPrivate?: string }): Promise<void> {
    await this.api.endpoint(
      "POST /v3/rooms/:roomId/read_markers",
      { roomId },
      { body: { "m.fully_read": markers.fullyRead, "m.read": markers.read, "m.read.private": markers.readPrivate } },
    );
  }

  async setTyping(roomId: string, typing: boolean, timeoutMs = 30_000): Promise<void> {
    await this.api.endpoint(
      "PUT /v3/rooms/:roomId/typing/:userId",
      { roomId, userId: this.userId },
      {
        body: typing ? { typing, timeout: timeoutMs } : { typing },
      },
    );
  }

  // ─── Reporting ────────────────────────────────────────────────────────────

  /** Report content to the server's administrators (https://spec.matrix.org/v1.19/client-server-api/#reporting-content). */
  async reportEvent(roomId: string, eventId: string, reason?: string): Promise<void> {
    await this.api.endpoint("POST /v3/rooms/:roomId/report/:eventId", { roomId, eventId }, { body: { reason } });
  }

  async reportRoom(roomId: string, reason: string): Promise<void> {
    await this.api.endpoint("POST /v3/rooms/:roomId/report", { roomId }, { body: { reason } });
  }

  async reportUser(userId: string, reason: string): Promise<void> {
    await this.api.endpoint("POST /v3/users/:userId/report", { userId }, { body: { reason } });
  }

  // ─── Tags (https://spec.matrix.org/v1.19/client-server-api/#room-tagging) ──

  /** A room's tags from the server (the synced ones are in the room's m.tag account data). */
  async getTags(roomId: string): Promise<Record<string, { order?: number }>> {
    return (await this.api.endpoint("GET /v3/user/:userId/rooms/:roomId/tags", { userId: this.userId, roomId }, {})).tags ?? {};
  }

  /** Tag a room: m.favourite, m.lowpriority, m.server_notice, or u.<anything>. `order` is in [0, 1]. */
  async setTag(roomId: string, tag: string, order?: number): Promise<void> {
    await this.api.endpoint(
      "PUT /v3/user/:userId/rooms/:roomId/tags/:tag",
      { userId: this.userId, roomId, tag },
      { body: order === undefined ? {} : { order } },
    );
  }

  async deleteTag(roomId: string, tag: string): Promise<void> {
    await this.api.endpoint("DELETE /v3/user/:userId/rooms/:roomId/tags/:tag", { userId: this.userId, roomId, tag }, {});
  }
}
