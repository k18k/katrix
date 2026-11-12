import { Membership } from "../shared/events.js";
import { MatrixEvent } from "./event.js";
import { ReactionGroup, Relations, ThreadSummary } from "./relations.js";
import { RoomState } from "./room-state.js";
import { Timeline } from "./timeline.js";
export interface RoomSummary {
  heroes?: string[];
  joinedMemberCount?: number;
  invitedMemberCount?: number;
}
export interface Receipt {
  eventId: string;
  ts?: number;
  threadId?: string;
}
export declare class Room {
  readonly roomId: string;
  readonly myUserId: string;
  membership: Membership;
  readonly state: RoomState;
  readonly timeline: Timeline;
  summary: RoomSummary;
  unreadNotifications: {
    highlight: number;
    notification: number;
  };
  /** Unread counts per thread root, from the server (unread_thread_notifications). */
  threadNotifications: Map<string, {
    highlight: number;
    notification: number;
  }>;
  /** Users typing now. */
  typing: string[];
  /** Receipts by type ("m.read", "m.read.private") and user. */
  receipts: Map<string, Map<string, Receipt>>;
  accountData: Map<string, Record<string, unknown>>;
  /** Edits, reactions, thread replies and references among the events that arrived here. */
  readonly relations: Relations;
  /** For an invite: the stripped state the invite carried. */
  inviteState: Array<{
    type: string;
    state_key: string;
    content: Record<string, unknown>;
    sender: string;
  }>;
  constructor(roomId: string, myUserId: string, membership: Membership, opts?: {
    maxTimelineEvents?: number;
  });
  /**
   * Index an event's relation, and update what it changes: the edit shown for its target, or
   * (for a target that just arrived) the edits that came before it. Returns the event whose
   * relations changed, if it is loaded.
   */
  applyRelations(event: MatrixEvent): MatrixEvent | undefined;
  /** Forget a redacted or dropped event's relation. Returns the event it related to, if loaded. */
  removeRelations(event: MatrixEvent): MatrixEvent | undefined;
  private refreshReplacement;
  /** The server's bundled edit of an event, to decrypt when it is encrypted. */
  bundledReplacement(original: MatrixEvent): MatrixEvent | undefined;
  private readonly bundled;
  reactions(eventId: string): ReactionGroup[];
  /**
   * A thread's summary: the server's bundled count and latest event (on the root's unsigned
   * m.relations), updated with the replies that arrived here since.
   */
  threadSummary(rootId: string): ThreadSummary | undefined;
  /** The thread roots seen in this room (fetch the full list with MatrixClient.fetchThreads). */
  threadRoots(): string[];
  /** The events of the main timeline: without thread replies (those that are not in a thread). */
  mainTimeline(): MatrixEvent[];
  /** The room this one was upgraded to (m.room.tombstone), if any. */
  successor(): {
    roomId: string;
    reason?: string;
  } | undefined;
  /** The room this one replaced (m.room.create's predecessor), if any. */
  predecessor(): {
    roomId: string;
    eventId?: string;
  } | undefined;
  /** The room type from m.room.create: "m.space" for spaces. */
  type(): string | undefined;
  isSpace(): boolean;
  /** Whether this user's member event marks the room as a direct chat (is_direct, set by the invite). */
  isDirect(): boolean;
  /** When something last happened in the room (its newest event), for sorting room lists. */
  lastActivity(): number;
  isEncrypted(): boolean;
  /**
   * The room's display name (https://spec.matrix.org/v1.16/client-server-api/#calculating-the-display-name-for-a-room):
   * m.room.name, else the canonical alias, else built from the heroes (or, without a summary,
   * from the other members), else "Empty Room".
   */
  name(): string;
  /** Members we encrypt for: joined, and invited when history visibility lets them read. */
  encryptionTargets(): string[];
  /** The newest event of the live timeline. */
  lastEvent(): MatrixEvent | undefined;
  readReceipt(userId: string, type?: string): Receipt | undefined;
}
//# sourceMappingURL=room.d.ts.map