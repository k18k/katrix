import type { Row } from "#storage/types.ts";
import type { StoredEvent } from "#core/rooms.ts";
import type { Homeserver } from "#homeserver.ts";
import type { Router } from "#http/router.ts";
import { type EventFilter } from "#api/filters.ts";
/** Fetch room events in stream order, applying visibility + filters, until `limit` are found. */
/**
 * A pagination position. Stream tokens (`s<n>`, from /sync) mean "everything persisted up
 * to n"; topological tokens (`t<depth>_<stream>`, from /messages) are a position in the
 * room's topological order (depth, then stream).
 */
export interface PageToken {
    depth: number | null;
    stream: number;
}
export declare function parsePageToken(raw: string | null): PageToken | null;
export declare const topoToken: (ev: {
    pdu: {
        depth: number;
    };
    stream: number;
}) => string;
/**
 * Fetch room events in topological order (as /messages requires), applying history
 * visibility and filters, until `limit` events are found.
 */
export declare function paginate(hs: Homeserver, userId: string | null, roomId: string, opts: {
    from: PageToken | null;
    to: PageToken | null;
    dir: "b" | "f";
    limit: number;
    filter?: EventFilter;
}): Promise<{
    events: StoredEvent[];
    end: string | null;
}>;
/**
 * A room's events ordered by timestamp in the search direction of `timestamp_to_event` (equal timestamps: the
 * topologically nearest first). Arrival order (stream) is not timestamp order for federated events (#105).
 * shortcut: reads all of the room's events; an indexed origin_server_ts column would bound it, once old rows get one.
 */
export declare function eventsByTimestamp(hs: Homeserver, roomId: string, dir: "f" | "b"): Promise<Row[]>;
export declare function registerTimelineRoutes(r: Router): void;
