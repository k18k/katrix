import type { MatrixEvent } from "./event.ts";
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
  /** Users typing now. */
  typing: string[] = [];
  /** Receipts by type ("m.read", "m.read.private") and user. */
  receipts = new Map<string, Map<string, Receipt>>();
  accountData = new Map<string, Record<string, unknown>>();
  /** For an invite: the stripped state the invite carried. */
  inviteState: Array<{ type: string; state_key: string; content: Record<string, unknown>; sender: string }> = [];

  constructor(roomId: string, myUserId: string, membership: Membership, opts: { maxTimelineEvents?: number } = {}) {
    this.roomId = roomId;
    this.myUserId = myUserId;
    this.membership = membership;
    this.timeline = new Timeline(opts.maxTimelineEvents);
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
