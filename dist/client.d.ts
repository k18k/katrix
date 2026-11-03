import type { Credentials, CredentialsStore, TokenProvider } from "./auth/types.ts";
import type { CryptoPrimitives } from "./crypto/primitives.ts";
import { E2EEEngine } from "./e2ee/engine.ts";
import type { DecryptedToDevice } from "./e2ee/olm.ts";
import { type HttpAdapter } from "./http/adapter.ts";
import { MatrixHttpApi } from "./http/api.ts";
import { MatrixError } from "./http/errors.ts";
import { MatrixEvent } from "./models/event.ts";
import { Room } from "./models/room.ts";
import type { ContentOf, Membership, RawEvent, ToDeviceEvent } from "./models/types.ts";
import type { E2EEProtocol, PickleKey } from "./protocol/protocol.ts";
import type { StorageAdapter } from "./storage/adapter.ts";
import { Store } from "./storage/store.ts";
import type { SyncResult, SyncTransport } from "./sync/types.ts";
import { type V3SyncOptions } from "./sync/v3.ts";
import { TypedEmitter } from "./util/emitter.ts";
import { type Logger } from "./util/logger.ts";
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
    };
    sync?: V3SyncOptions & {
        transport?: SyncTransport;
        pollTimeoutMs?: number;
        setPresence?: "online" | "offline" | "unavailable";
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
    private started?;
    private loaded;
    constructor(opts: ClientOptions);
    /** A transaction ID unique for this device (random, so restarts never reuse one). */
    makeTxnId(): string;
    getRoom(roomId: string): Room | undefined;
    getRooms(): Room[];
    getAccountData(type: string): Record<string, unknown> | undefined;
    isPrepared(): boolean;
    /** Load stored state, set up encryption, and start syncing. Resolves once the loop runs. */
    start(): Promise<void>;
    /** Stop syncing (in-flight sends finish). */
    stop(): Promise<void>;
    /** Resolves after the first sync round has been processed (immediately if it has). */
    waitForPrepared(): Promise<void>;
    /** Log out on the server and stop. */
    logout(): Promise<void>;
    close(): Promise<void>;
    private syncLoop;
    /** Apply one sync result: crypto and rooms in one unit of work, then events and decryption. */
    processSync(result: SyncResult): Promise<void>;
    private roomFor;
    private setMembership;
    private applyInvite;
    private applyJoined;
    private applyStateAndTimeline;
    private applyState;
    private applyRedaction;
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
    joinRoom(roomIdOrAlias: string, opts?: {
        via?: string[];
        reason?: string;
    }): Promise<string>;
    leaveRoom(roomId: string, reason?: string): Promise<void>;
    forgetRoom(roomId: string): Promise<void>;
    invite(roomId: string, userId: string, reason?: string): Promise<void>;
    kick(roomId: string, userId: string, reason?: string): Promise<void>;
    ban(roomId: string, userId: string, reason?: string): Promise<void>;
    unban(roomId: string, userId: string, reason?: string): Promise<void>;
    sendStateEvent<T extends string>(roomId: string, type: T, content: ContentOf<T>, stateKey?: string): Promise<string>;
    setRoomName(roomId: string, name: string): Promise<string>;
    setRoomTopic(roomId: string, topic: string): Promise<string>;
    /** Turn on encryption (it cannot be turned off again). */
    enableEncryption(roomId: string, opts?: {
        rotationPeriodMs?: number;
        rotationPeriodMsgs?: number;
    }): Promise<string>;
    /** Fetch the full member list (with lazy loading, /sync only sends the members it needs). */
    loadMembers(roomId: string): Promise<void>;
    /** Load up to `limit` older events into the room's timeline. Returns how many were added. */
    paginateBackwards(roomId: string, limit?: number): Promise<number>;
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
    sendReaction(roomId: string, eventId: string, key: string): Promise<string>;
    redactEvent(roomId: string, eventId: string, reason?: string): Promise<string>;
    sendReadReceipt(roomId: string, eventId: string, type?: "m.read" | "m.read.private"): Promise<void>;
    setTyping(roomId: string, typing: boolean, timeoutMs?: number): Promise<void>;
    whoami(): Promise<{
        user_id: string;
        device_id?: string;
    }>;
    getProfile(userId: string): Promise<{
        displayname?: string;
        avatar_url?: string;
    }>;
    setDisplayName(name: string): Promise<void>;
    setAccountData(type: string, content: Record<string, unknown>): Promise<void>;
}
