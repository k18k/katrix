import type { PDU } from "#core/events.ts";
import type { RequestContext } from "#http/router.ts";
import { UNSTABLE } from "#core/m.ts";
export interface EventFilter {
    limit?: number;
    types?: string[];
    not_types?: string[];
    senders?: string[];
    not_senders?: string[];
    rooms?: string[];
    not_rooms?: string[];
    contains_url?: boolean;
    lazy_load_members?: boolean;
    include_redundant_members?: boolean;
    unread_thread_notifications?: boolean;
    rel_types?: string[];
    not_rel_types?: string[];
    [UNSTABLE.ORG.MATRIX.MSC3874.REL_TYPES]?: string[];
    [UNSTABLE.ORG.MATRIX.MSC3874.NOT_REL_TYPES]?: string[];
}
export interface SyncFilter {
    event_fields?: string[];
    event_format?: "client" | "federation";
    /** MSC4429: profile fields whose changes are delivered in sync. */
    profile_fields?: {
        ids?: string[];
    };
    [UNSTABLE.ORG.MATRIX.MSC4429.PROFILE_FIELDS]?: {
        ids?: string[];
    };
    presence?: EventFilter;
    account_data?: EventFilter;
    room?: {
        rooms?: string[];
        not_rooms?: string[];
        include_leave?: boolean;
        timeline?: EventFilter;
        state?: EventFilter;
        ephemeral?: EventFilter;
        account_data?: EventFilter;
    };
}
export declare function matchesFilter(filter: EventFilter | undefined, ev: {
    type: string;
    sender?: string;
    room_id?: string;
    content?: any;
}): boolean;
export declare function roomAllowed(filter: SyncFilter, roomId: string): boolean;
export declare function validateSyncFilter(f: unknown): SyncFilter;
/** Parse the `filter` query param of /messages and /context (a JSON RoomEventFilter). */
export declare function parseRoomEventFilter(ctx: RequestContext): EventFilter | undefined;
/** Member events needed to render `events` when lazy-loading members. */
export declare function lazyMemberKeys(events: PDU[]): Set<string>;
