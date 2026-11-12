import { PDU } from "../core/events.js";
import { StateMap } from "../core/authrules.js";
import { MatrixError } from "../core/errors.js";
import { FederationClient } from "./client.js";
import { KeyRing } from "./keyring.js";
import { TransactionSender } from "./sender.js";
import { Homeserver } from "../homeserver.js";
export interface FederationOptions {
  /** Enable federation (talking to other homeservers). Default: false, so that a server only joins the network on purpose. */
  enabled?: boolean;
  /** Join remote rooms with partial state first (MSC3902 "faster joins"). Default true. */
  fasterJoins?: boolean;
  /** Verify remote TLS certificates. Default: true. Disable only for development. */
  verifyTls?: boolean;
  /** Only federate with these servers (allow list). */
  allowedServers?: string[];
  /** Never federate with these servers. */
  blockedServers?: string[];
}
/** Server-server API: verification, inbound processing and outbound requests. */
export declare class FederationService {
  private hs;
  readonly enabled: boolean;
  readonly fasterJoins: boolean;
  readonly client: FederationClient;
  readonly keyring: KeyRing;
  readonly sender: TransactionSender;
  private options;
  private seenTxns;
  private deviceStreams;
  constructor(hs: Homeserver, options?: FederationOptions);
  serverAllowed(serverName: string): boolean;
  private requireEnabled;
  /** Convert a stored event into its federation (wire) format. */
  toFederationPdu(pdu: PDU, version: string): Record<string, unknown>;
  computeEventId(raw: PDU | Record<string, unknown>, version: string): string;
  /**
   * Verify an incoming PDU: event ID, signatures and content hash. Events with a bad
   * content hash are redacted (as the spec requires) rather than rejected.
   */
  verifyPdu(raw: unknown, version: string, roomId: string): Promise<{
    pdu: PDU;
    joinAuthorisedSignatureValid?: boolean;
  }>;
  /** Servers with joined members in a room (excluding ourselves). */
  serversInRoom(state: StateMap, applyAcl?: boolean): Set<string>;
  /**
   * Servers to send a room's traffic to: joined servers per the state, plus, while the room's
   * state is partial (MSC3902), the servers the resident server said were in the room.
   */
  roomDestinations(roomId: string, state: StateMap, applyAcl?: boolean): Promise<Set<string>>;
  /** Send a newly created local event to every server in the room. */
  onLocalEvent(pdu: PDU, state: StateMap): void;
  /** Send an EDU to every server in the given rooms. */
  sendEduToRooms(roomIds: string[], eduType: string, content: Record<string, unknown>, durable?: boolean): Promise<void>;
  /** Servers sharing a room with a local user. */
  serversSharingRooms(userId: string): Promise<Set<string>>;
  onTyping(roomId: string, userId: string, typing: boolean): Promise<void>;
  onReceipt(roomId: string, userId: string, receiptType: string, eventId: string, ts: number, threadId: string): Promise<void>;
  onPresence(userId: string, presence: string, statusMsg: string | null): Promise<void>;
  /** Tell servers sharing rooms with a local user that their device list changed. */
  onDeviceListChange(userId: string, deletedDeviceId?: string, to?: Set<string>): Promise<void>;
  onSigningKeyUpdate(userId: string): Promise<void>;
  /** Deliver to-device messages addressed to remote users. */
  sendToDevice(sender: string, type: string, messages: Record<string, Record<string, unknown>>, messageId: string): Promise<void>;
  receiveTransaction(origin: string, txnId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  private processTransaction;
  /**
   * A PDU for a room we are not in can still matter: a local user's invite being
   * rescinded or their knock being accepted/rejected.
   */
  private handleOutOfRoomMembership;
  /** Process one incoming PDU (caller holds the room lock). */
  handlePdu(origin: string, roomId: string, version: string, raw: Record<string, unknown>, depth?: number): Promise<void>;
  /**
   * State before an event whose predecessors we lack: for each unknown prev event,
   * fetch the state at it (/state_ids) plus the event itself, then resolve all
   * predecessors' states. Throws if a required event cannot be fetched.
   */
  stateFromPrevs(origin: string, roomId: string, version: string, prevIds: string[], opts?: {
    remote?: boolean;
  }): Promise<Record<string, string>>;
  private fetchMissingAuthEvents;
  /** Fill a gap with /get_missing_events. Returns false when the response contained invalid events. */
  private fetchMissingPrevEvents;
  /** Fetch one event from a remote server and store it as an outlier. */
  private fetchEvent;
  private fetchRawEvent;
  /**
   * Fetch the state before an event from a remote server. Uses /state_ids and
   * fetches only unknown events (falling back to /state), storing them as outliers.
   */
  fetchStateBefore(origin: string, roomId: string, version: string, eventId: string): Promise<Record<string, string>>;
  /** Verify and store events that are not (yet) part of the timeline. */
  storeOutliers(roomId: string, version: string, raws: unknown[]): Promise<void>;
  /** Check an outlier against its own auth events. Returns a rejection reason, or null. */
  private checkOutlierAuth;
  /**
   * Whether a remote user's ephemeral activity (typing, receipts) in a room is accepted: they are
   * joined, or the room's state is partial (MSC3902) and their server is one of the room's servers.
   */
  private mayActInRoom;
  handleEdu(origin: string, edu: Record<string, unknown>): Promise<void>;
  /** Build a full event from a make_join/make_leave/make_knock template and sign it. */
  private finaliseTemplate;
  /** Join a room hosted on other servers. Returns the room ID. */
  joinRemoteRoom(userId: string, roomId: string, servers: string[], content: Record<string, unknown>): Promise<string>;
  private completeJoin;
  /** Leave (or reject an invite to) a room hosted elsewhere. */
  leaveRemoteRoom(userId: string, roomId: string, servers: string[], reason?: string): Promise<PDU>;
  knockRemoteRoom(userId: string, roomId: string, servers: string[], reason?: string): Promise<{
    pdu: PDU;
    knockState: unknown[];
  }>;
  /** Ask the invitee's server to sign an invite; returns the countersigned event. */
  sendInvite(pdu: PDU, version: string, inviteRoomState: Record<string, unknown>[]): Promise<PDU>;
  queryProfile(userId: string, field?: string): Promise<Record<string, unknown>>;
  queryAlias(alias: string): Promise<{
    room_id: string;
    servers: string[];
  }>;
  queryKeys(deviceKeys: Record<string, string[]>, timeoutMs?: number): Promise<{
    results: Record<string, unknown>[];
    failures: Record<string, unknown>;
  }>;
  claimKeys(oneTimeKeys: Record<string, Record<string, string>>, timeoutMs?: number): Promise<{
    results: Record<string, unknown>;
    failures: Record<string, unknown>;
  }>;
  queryPublicRooms(server: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  queryHierarchy(server: string, roomId: string, suggestedOnly: boolean): Promise<Record<string, unknown>>;
  /**
   * Fetch history preceding the oldest events we have. Returns the number of new
   * events stored. Caller should not hold the room lock.
   */
  backfill(roomId: string, fromEventIds: string[], limit?: number): Promise<number>;
  /** Download remote media (authenticated federation endpoint, falling back to the legacy one). */
  fetchMedia(server: string, mediaId: string, maxBytes: number): Promise<{
    data: Uint8Array;
    contentType: string | null;
    filename: string | null;
  }>;
  /** Remote members who should receive the invitee's stripped state. */
  strippedStateFor(state: StateMap): Record<string, unknown>[];
  /** Servers that may be able to help us join `roomId`. */
  candidateServers(roomId: string, extra?: string[]): string[];
  static memberServers(state: StateMap): string[];
  isMembershipVisibleTo(state: StateMap, server: string): boolean;
  stripped(pdu: PDU): Record<string, unknown>;
  error(status: number, errcode: string, message: string): MatrixError;
}
//# sourceMappingURL=index.d.ts.map