import { MatrixEvent } from "./event.ts";
import { Relations, type ReactionGroup, type ThreadSummary } from "./relations.ts";
import { RoomState } from "./room-state.ts";
import { Timeline } from "./timeline.ts";
import type { Membership } from "@katrix/shared";

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

export class Room {
  readonly roomId: string;
  readonly myUserId: string;
  membership: Membership;
  readonly state = new RoomState();
  readonly timeline: Timeline;
  summary: RoomSummary = {};
  unreadNotifications = { highlight: 0, notification: 0 };
  /** Unread counts per thread root, from the server (unread_thread_notifications). */
  threadNotifications = new Map<string, { highlight: number; notification: number }>();
  /** Users typing now. */
  typing: string[] = [];
  /** Receipts by type ("m.read", "m.read.private") and user. */
  receipts = new Map<string, Map<string, Receipt>>();
  accountData = new Map<string, Record<string, unknown>>();
  /** Edits, reactions, thread replies and references among the events that arrived here. */
  readonly relations: Relations;
  /** For an invite: the stripped state the invite carried. */
  inviteState: Array<{ type: string; state_key: string; content: Record<string, unknown>; sender: string }> = [];

  constructor(roomId: string, myUserId: string, membership: Membership, opts: { maxTimelineEvents?: number } = {}) {
    this.roomId = roomId;
    this.myUserId = myUserId;
    this.membership = membership;
    this.timeline = new Timeline(opts.maxTimelineEvents);
    this.relations = new Relations(myUserId);
  }

  /**
   * Index an event's relation, and update what it changes: the edit shown for its target, or
   * (for a target that just arrived) the edits that came before it. Returns the event whose
   * relations changed, if it is loaded.
   */
  applyRelations(event: MatrixEvent): MatrixEvent | undefined {
    if (event.eventId) this.refreshReplacement(event);
    const targetId = this.relations.add(event);
    if (!targetId) return undefined;
    const target = this.timeline.find(targetId);
    if (target) this.refreshReplacement(target);
    return target;
  }

  /** Forget a redacted or dropped event's relation. Returns the event it related to, if loaded. */
  removeRelations(event: MatrixEvent): MatrixEvent | undefined {
    const targetId = this.relations.remove(event);
    const target = targetId ? this.timeline.find(targetId) : undefined;
    if (target) this.refreshReplacement(target);
    return target;
  }

  private refreshReplacement(original: MatrixEvent): void {
    const bundled = original.unsigned["m.relations"] as { "m.replace"?: unknown } | undefined;
    const raw = bundled?.["m.replace"];
    let bundledEvent: MatrixEvent | undefined;
    // The server's bundled edit (v1.7) is a whole event; older servers sent only its ID.
    if (typeof raw === "object" && raw !== null && typeof (raw as { type?: unknown }).type === "string") {
      bundledEvent = this.bundled.get(original) ?? new MatrixEvent({ ...(raw as MatrixEvent["wire"]), room_id: this.roomId });
      this.bundled.set(original, bundledEvent);
    }
    original.replacement = this.relations.replacementFor(original, bundledEvent);
  }

  /** The server's bundled edit of an event, to decrypt when it is encrypted. */
  bundledReplacement(original: MatrixEvent): MatrixEvent | undefined {
    this.refreshReplacement(original);
    return this.bundled.get(original);
  }

  private readonly bundled = new WeakMap<MatrixEvent, MatrixEvent>();

  reactions(eventId: string): ReactionGroup[] {
    return this.relations.reactions(eventId);
  }

  /**
   * A thread's summary: the server's bundled count and latest event (on the root's unsigned
   * m.relations), updated with the replies that arrived here since.
   */
  threadSummary(rootId: string): ThreadSummary | undefined {
    const root = this.timeline.find(rootId);
    const bundled = (
      root?.unsigned["m.relations"] as
        | { "m.thread"?: { count?: number; latest_event?: MatrixEvent["wire"]; current_user_participated?: boolean } }
        | undefined
    )?.["m.thread"];
    const local = this.relations.threadReplies(rootId);
    if (!bundled && local.length === 0) return undefined;
    const latestLocal = local[local.length - 1];
    const bundledLatest = bundled?.latest_event ? new MatrixEvent({ ...bundled.latest_event, room_id: this.roomId }) : undefined;
    const latest =
      latestLocal && (!bundledLatest || (latestLocal.originServerTs ?? 0) >= (bundledLatest.originServerTs ?? 0))
        ? latestLocal
        : bundledLatest;
    const localNew = bundledLatest
      ? local.filter((e) => (e.originServerTs ?? 0) > (bundledLatest.originServerTs ?? 0)).length
      : local.length;
    return {
      rootId,
      count: (bundled?.count ?? 0) + localNew,
      latestEvent: latest,
      participated:
        bundled?.current_user_participated === true || local.some((e) => e.sender === this.myUserId) || root?.sender === this.myUserId,
    };
  }

  /** The thread roots seen in this room (fetch the full list with MatrixClient.fetchThreads). */
  threadRoots(): string[] {
    return this.relations.threadRoots();
  }

  /** The events of the main timeline: without thread replies (those that are not in a thread). */
  mainTimeline(): MatrixEvent[] {
    return this.timeline.events.filter((e) => !e.threadRootId);
  }

  /** The room this one was upgraded to (m.room.tombstone), if any. */
  successor(): { roomId: string; reason?: string } | undefined {
    const t = this.state.get("m.room.tombstone")?.content;
    return typeof t?.replacement_room === "string" ? { roomId: t.replacement_room, reason: t.body } : undefined;
  }

  /** The room this one replaced (m.room.create's predecessor), if any. */
  predecessor(): { roomId: string; eventId?: string } | undefined {
    const p = this.state.get("m.room.create")?.content.predecessor;
    return typeof p?.room_id === "string" ? { roomId: p.room_id, eventId: p.event_id } : undefined;
  }

  /** The room type from m.room.create: "m.space" for spaces. */
  type(): string | undefined {
    return this.state.get("m.room.create")?.content.type;
  }

  isSpace(): boolean {
    return this.type() === "m.space";
  }

  /** Whether this user's member event marks the room as a direct chat (is_direct, set by the invite). */
  isDirect(): boolean {
    const own = this.state.get("m.room.member", this.myUserId)?.content.is_direct;
    const invite = this.inviteState.find((e) => e.type === "m.room.member" && e.state_key === this.myUserId)?.content.is_direct;
    return own === true || invite === true;
  }

  /** When something last happened in the room (its newest event), for sorting room lists. */
  lastActivity(): number {
    for (let i = this.timeline.events.length - 1; i >= 0; i--) {
      const ts = this.timeline.events[i].originServerTs;
      if (ts !== undefined) return ts;
    }
    return 0;
  }

  isEncrypted(): boolean {
    return this.state.isEncrypted();
  }

  /**
   * The room's display name (https://spec.matrix.org/v1.16/client-server-api/#calculating-the-display-name-for-a-room):
   * m.room.name, else the canonical alias, else built from the heroes (or, without a summary,
   * from the other members), else "Empty Room".
   */
  name(): string {
    const fromInvite = (type: string, key: string) => this.inviteState.find((e) => e.type === type)?.content[key];
    const name = this.state.get("m.room.name")?.content.name ?? fromInvite("m.room.name", "name");
    if (typeof name === "string" && name.trim()) return name;
    const alias = this.state.get("m.room.canonical_alias")?.content.alias ?? fromInvite("m.room.canonical_alias", "alias");
    if (typeof alias === "string" && alias) return alias;

    const members = this.state.members();
    const nameOf = (userId: string) => members.find((m) => m.userId === userId)?.name ?? userId;
    let heroes = this.summary.heroes;
    if (!heroes || heroes.length === 0) {
      heroes = members
        .filter((m) => m.userId !== this.myUserId && (m.membership === "join" || m.membership === "invite"))
        .map((m) => m.userId)
        .sort()
        .slice(0, 5);
      // Alone in the room: name it after those who left.
      if (heroes.length === 0) {
        heroes = members
          .filter((m) => m.userId !== this.myUserId && m.membership === "leave")
          .map((m) => m.userId)
          .sort()
          .slice(0, 5);
      }
    }
    const joined = this.summary.joinedMemberCount ?? members.filter((m) => m.membership === "join").length;
    const invited = this.summary.invitedMemberCount ?? members.filter((m) => m.membership === "invite").length;
    const total = joined + invited;
    if (heroes.length === 0) {
      if (this.membership === "invite") {
        const inviter = this.inviteState.find((e) => e.type === "m.room.member" && e.state_key === this.myUserId)?.sender;
        if (inviter) return inviter;
      }
      return "Empty Room";
    }
    const names = heroes.map(nameOf);
    // The spec's examples: "Alice", "Alice and Bob", "Alice, Bob and 3 others"; and when
    // everyone else left, "Empty Room (was Alice)".
    const others = total - 1 - names.length;
    let text: string;
    if (others > 0) text = `${names.join(", ")} and ${others} other${others === 1 ? "" : "s"}`;
    else if (names.length === 1) text = names[0];
    else text = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return total <= 1 ? `Empty Room (was ${text})` : text;
  }

  /** Members we encrypt for: joined, and invited when history visibility lets them read. */
  encryptionTargets(): string[] {
    const visibility = this.state.get("m.room.history_visibility")?.content.history_visibility ?? "shared";
    // Invited users get the keys unless the room hides history from them until they join
    // (history_visibility "joined"), as matrix-js-sdk and matrix-rust-sdk do.
    const includeInvited = visibility !== "joined";
    return this.state
      .members()
      .filter((m) => m.membership === "join" || (includeInvited && m.membership === "invite"))
      .map((m) => m.userId);
  }

  /** The newest event of the live timeline. */
  lastEvent(): MatrixEvent | undefined {
    return this.timeline.events[this.timeline.events.length - 1];
  }

  readReceipt(userId: string, type = "m.read"): Receipt | undefined {
    return this.receipts.get(type)?.get(userId);
  }
}
