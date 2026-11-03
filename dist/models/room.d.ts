import type { MatrixEvent } from "./event.ts";
import { RoomState } from "./room-state.ts";
import { Timeline } from "./timeline.ts";
import type { Membership } from "./types.ts";
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
    /** Users typing now. */
    typing: string[];
    /** Receipts by type ("m.read", "m.read.private") and user. */
    receipts: Map<string, Map<string, Receipt>>;
    accountData: Map<string, Record<string, unknown>>;
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
