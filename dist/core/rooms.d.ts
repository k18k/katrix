import { ClientEvent, PDU } from "./events.js";
import { StateMap } from "./authrules.js";
import { Row } from "../storage/types.js";
import { StateIds } from "./stateres.js";
import { Homeserver } from "../homeserver.js";
export interface StoredEvent {
  pdu: PDU;
  stream: number;
  snapshot: number;
  txnId: string | null;
  txnToken: string | null;
  /** Membership of the viewing user at this event (set by `filterVisible`). */
  viewerMembership?: string;
  /** The event's predecessors were not all available when it was persisted. */
  gap?: boolean;
}
export interface EventDraft {
  type: string;
  content: Record<string, any>;
  state_key?: string;
  redacts?: string;
}
interface Outlier {
  pdu: PDU;
  snapshot: number | null;
  rejected: string | null;
  softFailed: boolean;
}
interface StateBefore {
  ids: StateIds;
  /** Snapshot ID when the state equals an existing snapshot (single predecessor). */
  snapshot: number | null;
}
export interface PersistOptions {
  /** Event created by this server (already authorised). */
  local?: boolean;
  txnId?: string;
  deviceId?: string;
  /** Explicit state before the event (e.g. from a send_join response or /state_ids). */
  stateBefore?: StateIds;
  /** Historical event fetched by backfill: placed before existing timeline, no state changes. */
  backfill?: boolean;
  /** For v12 rooms when the create event is not part of the current state yet. */
  createEvent?: PDU;
  /** Result of checking the restricted-join authorising server's signature. */
  joinAuthorisedSignatureValid?: boolean;
  /** Do not send this local event to other servers (they already have it). */
  noFederate?: boolean;
  /** Explicit stream position (used by backfill to preserve ordering). */
  stream?: number;
  /** Some prev_events are unknown (filled from remote state instead). */
  gap?: boolean;
}
export interface PersistResult {
  eventId: string;
  status: "persisted" | "soft_failed" | "rejected";
  reason?: string;
}
export declare class RoomService {
  private hs;
  private eventCache;
  private snapshotCache;
  private stateCache;
  private extremityCache;
  private outlierCache;
  private versions;
  private snapshotDepths;
  private sharingCache;
  private localClusterMarker;
  constructor(hs: Homeserver, singleInstance: boolean);
  /** Serialise writes per room (cluster-wide) so forward extremities stay consistent. */
  withLock<T>(roomId: string, fn: () => Promise<T>): Promise<T>;
  /** Drop cached data (for this instance only). */
  private invalidateLocal;
  /** Tell other instances to drop cached data. */
  invalidate(msg: {
    rooms?: string[];
    events?: string[];
    sharing?: boolean;
  }): void;
  forgetEventCache(eventId: string): void;
  /** Drop all cached data for a room (after it was purged). */
  forgetRoom(roomId: string): void;
  roomVersion(roomId: string): Promise<string | null>;
  exists(roomId: string): Promise<boolean>;
  rowToStored(row: Row): StoredEvent;
  getEvent(eventId: string): Promise<StoredEvent | null>;
  getEvents(eventIds: string[]): Promise<Map<string, StoredEvent>>;
  snapshotIds(snapshotId: number): Promise<Record<string, string>>;
  stateAtSnapshot(snapshotId: number): Promise<StateMap>;
  currentState(roomId: string): Promise<StateMap>;
  currentStateIds(roomId: string): Promise<StateIds>;
  /** Forward extremities: the latest events in the room DAG, used as prev_events of new events. */
  extremities(roomId: string): Promise<string[]>;
  getOutlier(eventId: string): Promise<Outlier | null>;
  /** Any known PDU (timeline event or non-rejected outlier). */
  getPdu(eventId: string): Promise<PDU | null>;
  getPdus(eventIds: string[]): Promise<Map<string, PDU>>;
  /** Whether we have seen this event at all (including rejected ones). */
  knowsEvent(eventId: string): Promise<boolean>;
  /** Snapshot ID of the state after an event, or null when the state is unknown. */
  snapshotOf(eventId: string): Promise<number | null>;
  stateIdsToMap(ids: StateIds): Promise<StateMap>;
  createEventOf(roomId: string): Promise<PDU | undefined>;
  /**
   * State before an event with the given prev_events: the snapshot of a single
   * predecessor, or the resolution of several. Throws MissingStateError when a
   * predecessor's state is unknown.
   */
  stateBefore(roomId: string, version: string, prevIds: string[], createEvent?: PDU): Promise<StateBefore>;
  /** Validate, authorise, sign and persist a new local event. Returns the event ID. */
  sendEvent(roomId: string, sender: string, draft: EventDraft, opts?: {
    txnId?: string;
    deviceId?: string;
    skipAuth?: boolean;
    ts?: number;
  }): Promise<string>;
  /** Build and sign (but do not persist) a local event on top of the current forward extremities. */
  buildLocalEvent(roomId: string, version: string, sender: string, draft: EventDraft, skipAuth?: boolean, ts?: number): Promise<PDU>;
  /**
   * Persist an event (local or remote). Remote events are checked against their auth
   * events, the state before them and the current state (soft failure).
   */
  persistEvent(roomId: string, version: string, pdu: PDU, opts?: PersistOptions): Promise<PersistResult>;
  /**
   * Finish a partial-state join (MSC3902): `fullBefore` is the complete state before our join
   * event. Recompute the state of the join and of every event received since, re-checking each
   * remote event against its now complete state (events wrongly accepted become rejected), then
   * rebuild the room's current state. Caller holds the room lock.
   */
  completePartialState(roomId: string, version: string, joinEventId: string, fullBefore: StateIds, notified: Set<string>): Promise<string[]>;
  /** The create event, also when the room's current state is not known yet (v12 joins). */
  private findCreateEvent;
  private store;
  private snapshotDepth;
  membership(roomId: string, userId: string): Promise<string>;
  requireJoined(roomId: string, userId: string): Promise<StateMap>;
  joinedMembers(roomId: string): Promise<string[]>;
  /** Users that should be woken up for events in this room. */
  private interestedUsers;
  roomsForUser(userId: string, membership?: string): Promise<string[]>;
  /**
   * Membership changes after `since` in the rooms where `userId` has a membership (in any state),
   * given the user's own membership rows if the caller has them.
   *
   * https://github.com/k18k/katrix/issues/31: /sync and device-list tracking
   * read every membership change on the server since their token and kept those in the user's
   * rooms; while many users joined, each sync parsed thousands of rows. This reads those rooms only.
   */
  membershipChangesSince(userId: string, since: number, mine?: Row[]): Promise<Row[]>;
  /** All users sharing at least one joined room with `userId` (including themselves). */
  usersSharingRooms(userId: string): Promise<Set<string>>;
  private prepareRedaction;
  private commitRedaction;
  /** Check whether a redaction would be permitted, before sending it. */
  checkRedactionAllowed(roomId: string, sender: string, targetId: string): Promise<void>;
  /**
   * Room state shared with invitees and knockers (MSC4311): full PDUs in federation
   * format, including the create event. Clients receive stripped versions.
   */
  strippedState(state: StateMap): Record<string, any>[];
  /** Filter events down to those `userId` may see according to history visibility. */
  filterVisible(userId: string | null, roomId: string, events: StoredEvent[]): Promise<StoredEvent[]>;
  /** Whether the user may view the room's current state / history at all (`world_readable` or member). */
  canPeek(roomId: string, userId: string): Promise<{
    joined: boolean;
    worldReadable: boolean;
    membership: string;
  }>;
  /** The state snapshot visible to a user who is no longer joined (state at their leave). */
  membershipEvent(roomId: string, userId: string): Promise<StoredEvent | null>;
  formatEvent(ev: StoredEvent, viewer?: {
    userId: string;
    deviceId: string;
  } | null, opts?: {
    includeRoomId?: boolean;
  }): ClientEvent;
  stateToList(state: StateMap): PDU[];
  createRoom(sender: string, body: Record<string, any>): Promise<{
    room_id: string;
    room_alias?: string;
  }>;
  resolveRoomIdOrAlias(idOrAlias: string): Promise<string>;
  /** Resolve a room ID or alias, including remote aliases; returns candidate servers for joining. */
  resolveRoom(idOrAlias: string): Promise<{
    roomId: string;
    servers: string[];
  }>;
  /** Whether the room was created on this server and we still have its state. */
  isLocallyHosted(roomId: string): Promise<boolean>;
  /** Whether any local user is joined to the room (i.e. this server participates in it). */
  serverIsJoined(roomId: string): Promise<boolean>;
  /** Servers that might help with a remote membership change for `userId` in `roomId`. */
  private remoteServersFor;
  /**
   * Record a membership event for a room this server may not participate in (remote
   * invites, rejections, knocks) so that it shows up in /sync.
   */
  recordRemoteMembership(pdu: PDU, version: string): Promise<void>;
  join(userId: string, roomId: string, extra?: {
    reason?: string;
    content?: Record<string, any>;
    servers?: string[];
  }): Promise<string>;
  private joinLocal;
  /** Whether an allowed room exists that we can't check (or the user is joined to), so another server might authorise. */
  private mayQualifyRemotely;
  private findRestrictedAuthoriser;
  invite(roomId: string, sender: string, target: string, opts?: {
    reason?: string;
    isDirect?: boolean;
    thirdPartyInvite?: {
      display_name: string;
      signed: Record<string, any>;
    };
  }): Promise<void>;
  /** Make this server's guests leave a room that no longer allows guests (spec, guest access module; #87). */
  private removeGuests;
  setMembership(roomId: string, sender: string, target: string, membership: "leave" | "ban" | "knock", reason?: string, via?: string[]): Promise<void>;
  private remoteMembership;
  /** Update the member event in every joined room after a profile change. */
  propagateProfile(userId: string): Promise<void>;
}
export {};
//# sourceMappingURL=rooms.d.ts.map