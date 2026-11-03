import { type StateMap } from "#core/authrules.ts";
import { type PDU } from "#core/events.ts";
import { type Rule } from "#core/pushrules.ts";
import type { StoredEvent } from "#core/rooms.ts";
import type { Homeserver } from "#homeserver.ts";
/** Look up a dotted path; `\.` escapes a literal dot in a key (e.g. `content.m\.relates_to`). */
export declare function valueAtPath(obj: unknown, path: string): unknown;
interface EvalContext {
    event: PDU;
    userId: string;
    displayName: string | null;
    memberCount: number;
    senderLevel: number;
    notificationLevels: Record<string, number>;
    /** MSC4306: whether the user subscribes to the event's thread; undefined outside threads. */
    threadSubscribed?: boolean;
}
/** Evaluate a user's push rules against an event; returns the actions of the first matching rule. */
export declare function evaluateRules(rules: Record<string, Rule[]>, ctx: EvalContext): unknown[] | null;
export declare function tweaksOf(actions: unknown[]): Record<string, unknown>;
/** Thread an event belongs to for notification purposes ("main" for the main timeline). */
export declare function threadIdOf(event: PDU): string;
/**
 * Push rule evaluation and push gateway delivery. Every new event is evaluated for
 * every local member; matches are stored for unread counts and `/notifications`.
 */
type Counts = {
    notification_count: number;
    highlight_count: number;
};
export interface UnreadCounts {
    readonly room: Readonly<Counts>;
    readonly threads: Readonly<Record<string, Readonly<Counts>>>;
}
export declare class PushService {
    private hs;
    constructor(hs: Homeserver);
    onEvent(ev: StoredEvent, state: StateMap, version: string): Promise<void>;
    /** Unread notification counts since the user's read receipts. */
    /** Stream positions up to which the user has read the room (unthreaded) and each thread. */
    private readPositions;
    isRead(row: Record<string, any>, read: {
        unthreaded: number;
        threads: Map<string, number>;
    }): boolean;
    unreadCounts(userId: string, roomId: string): Promise<UnreadCounts>;
    private countUnread;
    private deliver;
    /** Rows for `GET /notifications`. */
    list(userId: string, opts: {
        from: number | null;
        limit: number;
        onlyHighlight: boolean;
    }): Promise<{
        actions: any;
        event: import("#core/events.ts").ClientEvent;
        room_id: any;
        ts: any;
        read: boolean;
        stream: any;
    }[]>;
}
export {};
