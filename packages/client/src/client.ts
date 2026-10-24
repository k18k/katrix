import { CredentialsTokenProvider } from "./auth/login.ts";
import type { Credentials, CredentialsStore, TokenProvider } from "./auth/types.ts";
import { nobleCryptoPrimitives } from "./crypto/noble.ts";
import type { CryptoPrimitives } from "./crypto/primitives.ts";
import { E2EEEngine, type ToDeviceOutcome } from "./e2ee/engine.ts";
import type { DecryptedToDevice } from "./e2ee/olm.ts";
import { fetchHttpAdapter, type HttpAdapter } from "./http/adapter.ts";
import { MatrixHttpApi } from "./http/api.ts";
import { ConnectionError, MatrixError } from "./http/errors.ts";
import { MatrixEvent } from "./models/event.ts";
import { Room } from "./models/room.ts";
import type { ContentOf, Membership, RawEvent, ToDeviceEvent } from "./models/types.ts";
import { isAbortError, newAbortController, sleep, type AbortControllerLike } from "./platform.ts";
import { nativeE2EEProtocol } from "./protocol/native.ts";
import type { E2EEProtocol, PickleKey } from "./protocol/protocol.ts";
import type { StorageAdapter } from "./storage/adapter.ts";
import { MemoryStorage } from "./storage/memory.ts";
import { Store, type Transaction } from "./storage/store.ts";
import type { JoinedRoomUpdate, SyncResult, SyncTransport, TimelineUpdate } from "./sync/types.ts";
import { SyncV3Transport, type V3SyncOptions } from "./sync/v3.ts";
import { encodeBase64 } from "./util/base64.ts";
import { TypedEmitter } from "./util/emitter.ts";
import { describeError, noopLogger, type Logger } from "./util/logger.ts";
import { path } from "./util/query.ts";

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
  "room.redaction": [event: MatrixEvent, room: Room, redaction: RawEvent];
  "room.typing": [room: Room, userIds: string[]];
  "room.receipt": [room: Room, event: RawEvent];
  "room.accountData": [room: Room, event: RawEvent];
  "event.decrypted": [event: MatrixEvent, room: Room];
  accountData: [event: RawEvent];
  toDevice: [event: ToDeviceEvent, decrypted?: DecryptedToDevice];
  presence: [event: RawEvent];
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
    const e2ee = opts.e2ee === false ? undefined : (opts.e2ee ?? {});
    this.primitives = e2ee?.primitives ?? nobleCryptoPrimitives();
    if (e2ee) {
      this.e2ee = new E2EEEngine({
        api: this.api,
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
    await this.api.request("POST", "/v3/logout", { body: {} });
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
    this.syncToken = result.nextBatch;

    for (const emit of emits) emit();
    for (const { event, decrypted } of outcome.events) this.emit("toDevice", event, decrypted);
    for (const ev of result.presence) this.emit("presence", ev);

    if (this.e2ee) {
      await this.e2ee.afterSync(result, outcome);
      // Know the senders' devices before decrypting, so events are attributed to them.
      if (encryptedJoins.size > 0)
        await this.e2ee.devices.refresh([...encryptedJoins]).catch((e) => this.logger.warn("device query failed", describeError(e)));
      for (const { event, room } of toDecrypt) await this.decryptAndEmit(event, room);
      for (const s of outcome.newSessions) await this.retryAwaiting(s.roomId, s.sessionId);
    }
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
    state: RawEvent[],
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
      const wire = { ...raw, room_id: room.roomId } as RawEvent;
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
      if (event.isEncrypted()) toDecrypt.push({ event, room });
      emits.push(() => this.emit("room.timeline", event, room, { live: true }));
    }
  }

  private applyState(tx: Transaction, room: Room, raw: RawEvent, emits: Array<() => void>, encryptedJoins: Set<string>): void {
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

  private applyRedaction(room: Room, redaction: RawEvent, emits: Array<() => void>): void {
    const target = redaction.redacts ?? (redaction.content as { redacts?: string }).redacts;
    if (typeof target !== "string") return;
    const event = room.timeline.find(target);
    if (!event) return;
    event.applyRedaction(redaction);
    emits.push(() => this.emit("room.redaction", event, room, redaction));
  }

  private applyEphemeral(room: Room, ev: RawEvent, emits: Array<() => void>): void {
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
      for (const [, raw] of await this.store.list<RawEvent>("room_state", `${roomId}|`)) room.state.setRaw(raw);
      room.state.membersLoaded = stored.membersLoaded ?? false;
      const timeline = await this.store.get<{ events: RawEvent[]; complete: boolean }>("room_timeline", roomId);
      room.timeline.append((timeline?.events ?? []).map((raw) => new MatrixEvent(raw)));
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
    } else if (event.decryptionError === "MISSING_ROOM_KEY" || event.decryptionError === "UNKNOWN_MESSAGE_INDEX") {
      const sessionId = (event.wire.content as { session_id?: unknown }).session_id;
      if (typeof sessionId !== "string") return;
      const key = `${room.roomId}|${sessionId}`;
      let set = this.awaitingKeys.get(key);
      if (!set) this.awaitingKeys.set(key, (set = new Set()));
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
    const res = await this.api.request<{ room_id: string }>("POST", "/v3/createRoom", {
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
    });
    return res.room_id;
  }

  async joinRoom(roomIdOrAlias: string, opts: { via?: string[]; reason?: string } = {}): Promise<string> {
    const res = await this.api.request<{ room_id: string }>("POST", path`/v3/join/${roomIdOrAlias}`, {
      query: { via: opts.via, server_name: opts.via },
      body: { reason: opts.reason },
    });
    return res.room_id;
  }

  async leaveRoom(roomId: string, reason?: string): Promise<void> {
    await this.api.request("POST", path`/v3/rooms/${roomId}/leave`, { body: { reason } });
  }

  async forgetRoom(roomId: string): Promise<void> {
    await this.api.request("POST", path`/v3/rooms/${roomId}/forget`, { body: {} });
    this.rooms.delete(roomId);
    await this.store.transaction(async (tx) => {
      tx.delete("rooms", roomId);
      tx.delete("room_timeline", roomId);
      for (const [key] of await tx.list("room_state", `${roomId}|`)) tx.delete("room_state", key);
    });
  }

  async invite(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.api.request("POST", path`/v3/rooms/${roomId}/invite`, { body: { user_id: userId, reason } });
  }

  async kick(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.api.request("POST", path`/v3/rooms/${roomId}/kick`, { body: { user_id: userId, reason } });
  }

  async ban(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.api.request("POST", path`/v3/rooms/${roomId}/ban`, { body: { user_id: userId, reason } });
  }

  async unban(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.api.request("POST", path`/v3/rooms/${roomId}/unban`, { body: { user_id: userId, reason } });
  }

  async sendStateEvent<T extends string>(roomId: string, type: T, content: ContentOf<T>, stateKey = ""): Promise<string> {
    const res = await this.api.request<{ event_id: string }>("PUT", path`/v3/rooms/${roomId}/state/${type}/${stateKey}`, { body: content });
    return res.event_id;
  }

  setRoomName(roomId: string, name: string): Promise<string> {
    return this.sendStateEvent(roomId, "m.room.name", { name });
  }

  setRoomTopic(roomId: string, topic: string): Promise<string> {
    return this.sendStateEvent(roomId, "m.room.topic", { topic });
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
    const res = await this.api.request<{ chunk?: RawEvent[] }>("GET", path`/v3/rooms/${roomId}/members`);
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
    const res = await this.api.request<{ chunk?: RawEvent[]; state?: RawEvent[]; end?: string }>(
      "GET",
      path`/v3/rooms/${roomId}/messages`,
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
    for (const emit of emits) emit();
    for (const event of added) {
      if (event.isEncrypted()) await this.decryptAndEmit(event, room);
      this.emit("room.timeline", event, room, { live: false });
    }
    return added.length;
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
      this.emit("room.localEcho", echo, room);
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
      const encrypted = await this.api.request("GET", path`/v3/rooms/${roomId}/state/m.room.encryption/`).then(
        () => true,
        (e) => {
          if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return false;
          throw e;
        },
      );
      if (encrypted) throw new Error(`Room ${roomId} is encrypted and not synced yet: sync first`);
    }
    const res = await this.api.request<{ event_id: string }>("PUT", path`/v3/rooms/${roomId}/send/${sendType}/${txnId}`, { body });
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

  sendReaction(roomId: string, eventId: string, key: string): Promise<string> {
    return this.sendEvent(roomId, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key } });
  }

  async redactEvent(roomId: string, eventId: string, reason?: string): Promise<string> {
    const res = await this.api.request<{ event_id: string }>("PUT", path`/v3/rooms/${roomId}/redact/${eventId}/${this.makeTxnId()}`, {
      body: { reason },
    });
    return res.event_id;
  }

  async sendReadReceipt(roomId: string, eventId: string, type: "m.read" | "m.read.private" = "m.read"): Promise<void> {
    await this.api.request("POST", path`/v3/rooms/${roomId}/receipt/${type}/${eventId}`, { body: {} });
  }

  async setTyping(roomId: string, typing: boolean, timeoutMs = 30_000): Promise<void> {
    await this.api.request("PUT", path`/v3/rooms/${roomId}/typing/${this.userId}`, {
      body: typing ? { typing, timeout: timeoutMs } : { typing },
    });
  }

  // ─── Account ──────────────────────────────────────────────────────────────

  whoami(): Promise<{ user_id: string; device_id?: string }> {
    return this.api.request("GET", "/v3/account/whoami");
  }

  getProfile(userId: string): Promise<{ displayname?: string; avatar_url?: string }> {
    return this.api.request("GET", path`/v3/profile/${userId}`);
  }

  async setDisplayName(name: string): Promise<void> {
    await this.api.request("PUT", path`/v3/profile/${this.userId}/displayname`, { body: { displayname: name } });
  }

  async setAccountData(type: string, content: Record<string, unknown>): Promise<void> {
    await this.api.request("PUT", path`/v3/user/${this.userId}/account_data/${type}`, { body: content });
  }
}
