import { AccountApi } from "./account/account.js";
import { AdminApi } from "./account/admin.js";
import { DevicesApi } from "./account/devices.js";
import { SearchResponse } from "./shared/api/rooms.js";
import { PresenceApi, ProfileApi } from "./account/profile.js";
import { Credentials, CredentialsStore, TokenProvider } from "./auth/types.js";
import { CryptoPrimitives } from "./crypto/primitives.js";
import { E2EEEngine } from "./e2ee/engine.js";
import { DecryptedToDevice } from "./e2ee/olm.js";
import { HttpAdapter } from "./http/adapter.js";
import { MatrixHttpApi } from "./http/api.js";
import { MatrixError } from "./http/errors.js";
import { DirectoryApi } from "./directory/directory.js";
import { MediaApi } from "./media/media.js";
import { PushApi, PushOutcome } from "./push/push.js";
import { SpacesApi } from "./spaces/spaces.js";
import { PeerConnectionFactory } from "./voip/call.js";
import { CallsApi } from "./voip/calls.js";
import { MatrixEvent } from "./models/event.js";
import { Room } from "./models/room.js";
import { ClientEvent, ContentOf, Membership, ToDeviceEvent } from "./shared/events.js";
import { RoomEventFilter } from "./shared/api/account.js";
import { E2EEProtocol, PickleKey } from "./protocol/protocol.js";
import { StorageAdapter } from "./storage/adapter.js";
import { Store } from "./storage/store.js";
import { SyncResult, SyncTransport } from "./sync/types.js";
import { V3SyncOptions } from "./sync/v3.js";
import { TypedEmitter } from "./util/emitter.js";
import { Logger } from "./util/logger.js";
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
  e2ee?: false | {
    primitives?: CryptoPrimitives;
    protocol?: E2EEProtocol;
    pickleKey?: PickleKey;
    /** Share room keys only with verified devices (default false: every device, trusted on first use). */
    onlyVerifiedDevices?: boolean;
  };
  sync?: V3SyncOptions & {
    transport?: SyncTransport;
    pollTimeoutMs?: number;
    setPresence?: "online" | "offline" | "unavailable";
  };
  /** Voice and video calls: the app's WebRTC (RTCPeerConnection, or react-native-webrtc's). */
  calls?: {
    peerConnectionFactory?: PeerConnectionFactory;
  };
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
/**
 * A Matrix client: sync, rooms, timelines, sending, and end-to-end encryption.
 *
 * One /sync round is processed as one unit of work: its to-device messages (room keys, Olm
 * sessions, used one-time keys), device list changes, room updates and the new sync token are
 * stored together. A crash in between repeats the round instead of losing keys: to-device
 * messages are deleted on the server only once a sync with the next token is made.
 */
export declare class MatrixClient extends TypedEmitter<ClientEvents> {
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
  private readonly logger;
  private readonly primitives;
  private readonly transport;
  private readonly opts;
  private readonly tokens;
  private readonly rooms;
  private syncToken?;
  private running;
  private syncAbort?;
  private loop?;
  private prepared;
  private txnCounter;
  /** Encrypted events waiting for their room key, by `${roomId}|${sessionId}`. */
  private awaitingKeys;
  /** Our events being sent, by transaction ID, to match the copy that comes down /sync. */
  private localEchoes;
  private accountData;
  private presenceByUser;
  /** set_presence for /sync: from the options, then from the last presence.set(). */
  private setPresence?;
  private started?;
  private loaded;
  /** During a sync round after the first: the new events from others, to evaluate push rules on. */
  private notifyQueue?;
  /** During a sync round: the new live events, for the m.call.* among them once decrypted. */
  private callQueue?;
  /** Encrypted events still to be evaluated once decrypted. */
  private notifyOnDecrypt;
  constructor(opts: ClientOptions);
  /** A transaction ID unique for this device (random, so restarts never reuse one). */
  makeTxnId(): string;
  getRoom(roomId: string): Room | undefined;
  getRooms(): Room[];
  getAccountData(type: string): Record<string, unknown> | undefined;
  /** A user's latest presence from /sync (this.presence.get asks the server). */
  getPresence(userId: string): {
    presence: "online" | "offline" | "unavailable";
    last_active_ago?: number;
    status_msg?: string;
    currently_active?: boolean;
  } | undefined;
  isPrepared(): boolean;
  /** Load stored state, set up encryption, and start syncing. Resolves once the loop runs. */
  start(): Promise<void>;
  /** Stop syncing (in-flight sends finish). */
  stop(): Promise<void>;
  /** Resolves after the first sync round has been processed (immediately if it has). */
  waitForPrepared(): Promise<void>;
  /**
   * Log out on the server and stop. The device's keys are gone on the server then, so its
   * stored state is useless: `clearStorage` (default true) deletes it, keys included.
   */
  logout(opts?: {
    clearStorage?: boolean;
  }): Promise<void>;
  /** Delete everything this client stored (rooms, sync token, crypto state). The client is unusable afterwards. */
  clearStorage(): Promise<void>;
  close(): Promise<void>;
  private syncLoop;
  /** Apply one sync result: crypto and rooms in one unit of work, then events and decryption. */
  processSync(result: SyncResult): Promise<void>;
  private routeVerification;
  private notifyIfRulesSay;
  /**
   * Unread counts. For an unencrypted room they are the server's. For an encrypted room the
   * server can only count every encrypted message, so they are counted here, on the decrypted
   * events after the user's latest receipt (their own messages count as read): `exact` is false
   * when that receipt is older than the timeline in memory, and the count is a lower bound then.
   */
  getUnreadCounts(roomId: string): {
    notification: number;
    highlight: number;
    exact: boolean;
  };
  private roomFor;
  private setMembership;
  private applyInvite;
  private applyJoined;
  private applyStateAndTimeline;
  private applyState;
  private applyRedaction;
  /** Index an event's relation; a server-bundled edit of it is decrypted along with it. */
  private indexRelations;
  private applyEphemeral;
  private persistRoom;
  private loadFromStore;
  /** After start(): decrypt the stored timelines (plaintext is never stored). */
  decryptStoredTimelines(): Promise<void>;
  private decryptAndEmit;
  private retryAwaiting;
  createRoom(opts?: {
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
    initialState?: Array<{
      type: string;
      state_key?: string;
      content: Record<string, unknown>;
    }>;
    powerLevelContentOverride?: Record<string, unknown>;
    creationContent?: Record<string, unknown>;
  }): Promise<string>;
  /**
   * Join a room. Accepting an invite that was sent as a direct chat (is_direct) also records the
   * room in m.direct, as the spec asks of the invitee's client.
   */
  joinRoom(roomIdOrAlias: string, opts?: {
    via?: string[];
    reason?: string;
  }): Promise<string>;
  /** The m.direct map: user ID → the rooms that are direct chats with them. */
  getDirectRooms(): Record<string, string[]>;
  /** The direct chat with a user this user is in and the other user has not left, newest first. */
  findDirectRoom(userId: string): Room;
  /** Start a direct chat (encrypted unless `encrypted: false`) and record it in m.direct. */
  createDirectRoom(userId: string, opts?: {
    encrypted?: boolean;
  }): Promise<string>;
  /**
   * Record (or with `direct: false`, remove) a room as a direct chat with `userId` in m.direct.
   * Read from the server first, so a change made on another device since the last sync is kept.
   */
  markDirect(roomId: string, userId: string, direct?: boolean): Promise<void>;
  /**
   * Join the room an upgraded room points to (m.room.tombstone), through the server of whoever
   * upgraded it. Resolves with the new room's ID, or undefined when the room was not upgraded.
   */
  followUpgrade(roomId: string): Promise<string | undefined>;
  /** Ask to join a room whose join rule is `knock` (https://spec.matrix.org/v1.19/client-server-api/#knocking-on-rooms). */
  knockRoom(roomIdOrAlias: string, opts?: {
    via?: string[];
    reason?: string;
  }): Promise<string>;
  /** The IDs of the rooms the user is joined to, from the server (getRooms has the synced ones). */
  getJoinedRooms(): Promise<string[]>;
  /**
   * Upgrade a room to a new room version (https://spec.matrix.org/v1.19/client-server-api/#room-upgrades):
   * the server creates the replacement room and tombstones this one. Resolves with the new room's ID.
   */
  upgradeRoom(roomId: string, newVersion: string, opts?: {
    additionalCreators?: string[];
  }): Promise<string>;
  /** The rooms both this user and `userId` are joined to (all pages). */
  getMutualRooms(userId: string): Promise<string[]>;
  leaveRoom(roomId: string, reason?: string): Promise<void>;
  forgetRoom(roomId: string): Promise<void>;
  invite(roomId: string, userId: string, reason?: string): Promise<void>;
  kick(roomId: string, userId: string, reason?: string): Promise<void>;
  ban(roomId: string, userId: string, reason?: string): Promise<void>;
  unban(roomId: string, userId: string, reason?: string): Promise<void>;
  /** Invite by email or phone number through an identity server (https://spec.matrix.org/v1.19/client-server-api/#third-party-invites). */
  inviteThirdParty(roomId: string, invite: {
    idServer: string;
    idAccessToken: string;
    medium: string;
    address: string;
  }): Promise<void>;
  sendStateEvent<T extends string>(roomId: string, type: T, content: ContentOf<T>, stateKey?: string): Promise<string>;
  setRoomName(roomId: string, name: string): Promise<string>;
  setRoomTopic(roomId: string, topic: string): Promise<string>;
  setRoomAvatar(roomId: string, mxcUri: string, info?: Record<string, unknown>): Promise<string>;
  setJoinRule(roomId: string, content: ContentOf<"m.room.join_rules">): Promise<string>;
  setHistoryVisibility(roomId: string, visibility: ContentOf<"m.room.history_visibility">["history_visibility"]): Promise<string>;
  setGuestAccess(roomId: string, access: ContentOf<"m.room.guest_access">["guest_access"]): Promise<string>;
  setCanonicalAlias(roomId: string, alias: string | null, altAliases?: string[]): Promise<string>;
  setPinnedEvents(roomId: string, eventIds: string[]): Promise<string>;
  /**
   * Set one user's power level (null resets it to users_default). Reads the current power levels
   * from the synced room state (or the server), so it must not race another change.
   */
  setPowerLevel(roomId: string, userId: string, level: number | null): Promise<string>;
  /** A state event's content from the server; undefined when there is none. */
  fetchStateEvent(roomId: string, type: string, stateKey?: string): Promise<{
    [x: string]: unknown;
  } | undefined>;
  /** The room's whole current state from the server. */
  fetchRoomState(roomId: string): Promise<MatrixEvent<string>[]>;
  /** Members with their display names and avatars, as the server has them now. */
  fetchJoinedMembers(roomId: string): Promise<Record<string, {
    displayName?: string;
    avatarUrl?: string;
  }>>;
  /** Member events from the server, optionally at an earlier point (`at`, a sync token) or by membership. */
  fetchMembers(roomId: string, opts?: {
    at?: string;
    membership?: Membership;
    notMembership?: Membership;
  }): Promise<MatrixEvent<string>[]>;
  /** Turn on encryption (it cannot be turned off again). */
  enableEncryption(roomId: string, opts?: {
    rotationPeriodMs?: number;
    rotationPeriodMsgs?: number;
  }): Promise<string>;
  /** Fetch the full member list (with lazy loading, /sync only sends the members it needs). */
  loadMembers(roomId: string): Promise<void>;
  /** Load up to `limit` older events into the room's timeline. Returns how many were added. */
  paginateBackwards(roomId: string, limit?: number): Promise<number>;
  /** One event from the server, decrypted when it is encrypted and its key is known. */
  fetchEvent(roomId: string, eventId: string): Promise<MatrixEvent<string>>;
  /** An event with the events around it (to jump to a reply's target, a search result, a permalink). */
  fetchContext(roomId: string, eventId: string, opts?: {
    limit?: number;
    filter?: RoomEventFilter;
  }): Promise<{
    event: MatrixEvent<string> | undefined;
    before: MatrixEvent<string>[];
    after: MatrixEvent<string>[];
    state: MatrixEvent<string>[];
    start: string | undefined;
    end: string | undefined;
  }>;
  /**
   * The events that relate to an event (https://spec.matrix.org/v1.19/client-server-api/#relationship-types):
   * all of them, or of one relation type (m.annotation, m.replace, m.thread, m.reference) and
   * event type. `recurse` follows relations of relations (v1.10).
   */
  fetchRelations(roomId: string, eventId: string, opts?: {
    relType?: string;
    eventType?: string;
    from?: string;
    to?: string;
    limit?: number;
    dir?: "b" | "f";
    recurse?: boolean;
  }): Promise<{
    events: MatrixEvent<string>[];
    nextBatch: string | undefined;
    prevBatch: string | undefined;
  }>;
  /** Thread roots of a room, newest activity first (https://spec.matrix.org/v1.19/client-server-api/#threads). */
  fetchThreads(roomId: string, opts?: {
    include?: "all" | "participated";
    limit?: number;
    from?: string;
  }): Promise<{
    roots: MatrixEvent<string>[];
    nextBatch: string | undefined;
  }>;
  /** The event closest to a point in time, searching forwards or backwards (to jump to a date). */
  timestampToEvent(roomId: string, ts: number, dir?: "f" | "b"): Promise<{
    eventId: string;
    originServerTs: number;
  }>;
  /**
   * Server-side search of room events (https://spec.matrix.org/v1.19/client-server-api/#server-side-search).
   * Encrypted events cannot be searched by the server.
   */
  search(term: string, opts?: {
    keys?: Array<"content.body" | "content.name" | "content.topic">;
    filter?: RoomEventFilter;
    orderBy?: "recent" | "rank";
    context?: {
      beforeLimit?: number;
      afterLimit?: number;
      includeProfile?: boolean;
    };
    includeState?: boolean;
    groupBy?: Array<"room_id" | "sender">;
    nextBatch?: string;
  }): Promise<SearchResponse>;
  /**
   * A room's state and latest messages without joining it (world-readable rooms;
   * https://spec.matrix.org/v1.19/client-server-api/#peeking).
   */
  peekRoom(roomId: string): Promise<{
    state: MatrixEvent<string>[];
    messages: MatrixEvent<string>[];
    end: string | undefined;
  }>;
  /** New events of a peeked room after `from` (the `end` of peekRoom), waiting up to `timeoutMs`. */
  peekEvents(roomId: string, from?: string, timeoutMs?: number): Promise<{
    events: MatrixEvent<string>[];
    end: string | undefined;
  }>;
  private fetched;
  /**
   * Send a room event. It appears in the room's timeline at once (a local echo with
   * `localStatus`), is encrypted when the room is, and is matched with its copy from /sync by
   * transaction ID. Resolves with the event ID.
   *
   * In an encrypted room, an event is never sent in the clear: without the E2EE engine, sending
   * fails.
   */
  sendEvent<T extends string>(roomId: string, type: T, content: ContentOf<T>, opts?: {
    txnId?: string;
  }): Promise<string>;
  /** Send a failed event again, with its transaction ID (the server deduplicates). */
  resendEvent(event: MatrixEvent): Promise<string>;
  private sendPrepared;
  sendMessage(roomId: string, content: ContentOf<"m.room.message">): Promise<string>;
  sendText(roomId: string, body: string): Promise<string>;
  /**
   * Upload a file and send it as an m.image, m.video, m.audio or m.file message. In an encrypted
   * room the file is encrypted first (the event carries `file`, not `url`), so the server never
   * sees it. `info` is sent as given (mimetype, size, w, h, duration, …); size and mimetype are
   * filled in when missing.
   */
  sendFile(roomId: string, data: Uint8Array, opts: {
    msgtype?: "m.image" | "m.video" | "m.audio" | "m.file";
    filename: string;
    contentType?: string;
    body?: string;
    info?: Record<string, unknown>;
  }): Promise<string>;
  /**
   * Edit a message (https://spec.matrix.org/v1.19/client-server-api/#event-replacements). The
   * edit's top-level body is a "* …" fallback for clients without edits; `m.mentions` at the top
   * level holds only the users newly mentioned, so they are not pinged twice.
   */
  sendEdit(roomId: string, eventId: string, newContent: ContentOf<"m.room.message">): Promise<string>;
  /**
   * Reply to an event (rich replies, https://spec.matrix.org/v1.19/client-server-api/#rich-replies).
   * The replied-to sender is mentioned. A reply to an event in a thread stays in the thread.
   */
  sendReply(roomId: string, inReplyTo: string, content: ContentOf<"m.room.message">): Promise<string>;
  /**
   * Send a message in a thread (https://spec.matrix.org/v1.19/client-server-api/#threading). It
   * carries a fallback reply to the thread's latest event, for clients without threads.
   */
  sendThreadMessage(roomId: string, rootId: string, content: ContentOf<"m.room.message">): Promise<string>;
  /** Take back this user's reaction with `key` on an event (redacts the reaction). Resolves false if there was none. */
  removeReaction(roomId: string, eventId: string, key: string): Promise<boolean>;
  sendReaction(roomId: string, eventId: string, key: string): Promise<string>;
  redactEvent(roomId: string, eventId: string, reason?: string): Promise<string>;
  /**
   * A read receipt (https://spec.matrix.org/v1.19/client-server-api/#receipts). `threadId` makes it
   * a threaded receipt: "main" for the main timeline, or a thread root's event ID.
   */
  sendReadReceipt(roomId: string, eventId: string, type?: "m.read" | "m.read.private" | "m.fully_read", opts?: {
    threadId?: string;
  }): Promise<void>;
  /** Move the fully-read marker and the read receipts in one request (https://spec.matrix.org/v1.19/client-server-api/#fully-read-markers). */
  setReadMarkers(roomId: string, markers: {
    fullyRead?: string;
    read?: string;
    readPrivate?: string;
  }): Promise<void>;
  setTyping(roomId: string, typing: boolean, timeoutMs?: number): Promise<void>;
  /** Report content to the server's administrators (https://spec.matrix.org/v1.19/client-server-api/#reporting-content). */
  reportEvent(roomId: string, eventId: string, reason?: string): Promise<void>;
  reportRoom(roomId: string, reason: string): Promise<void>;
  reportUser(userId: string, reason: string): Promise<void>;
  /** A room's tags from the server (the synced ones are in the room's m.tag account data). */
  getTags(roomId: string): Promise<Record<string, {
    order?: number;
  }>>;
  /** Tag a room: m.favourite, m.lowpriority, m.server_notice, or u.<anything>. `order` is in [0, 1]. */
  setTag(roomId: string, tag: string, order?: number): Promise<void>;
  deleteTag(roomId: string, tag: string): Promise<void>;
}
//# sourceMappingURL=client.d.ts.map