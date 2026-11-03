import { type PDU } from "#core/events.ts";
import type { StoredEvent } from "#core/rooms.ts";
import type { Session } from "#core/auth.ts";
import type { Homeserver } from "#homeserver.ts";
import type { Row } from "#storage/types.ts";
import type { Router } from "#http/router.ts";
import { type SyncFilter } from "#api/filters.ts";
import { UNSTABLE } from "#core/m.ts";
interface SyncToken {
    pos: number;
    toDevice: number;
    /**
     * The response with this token delivered to-device messages, so a sync with it acknowledges
     * them. https://github.com/k18k/katrix/issues/42: every sync ran the delete,
     * though almost none had anything to acknowledge. Deletes cover all positions up to `toDevice`,
     * so messages delivered under an unmarked token go with the next acknowledgement.
     */
    ack?: boolean;
}
/** A stripped state event as clients expect it. */
export declare function toStripped(ev: Record<string, any>): Record<string, any>;
export interface SyncParams {
    session: Session;
    /**
     * MSC4222: return the state at the end of the timeline instead of `state`, under the
     * key matching the parameter the client used: `state_after` for the stable
     * `use_state_after`, `org.matrix.msc4222.state_after` for the unstable
     * `org.matrix.msc4222.use_state_after` (which matrix-js-sdk and Element send, and read
     * back only under the unstable key).
     */
    useStateAfter?: boolean;
    stateAfterKey?: "state_after" | typeof UNSTABLE.ORG.MATRIX.MSC4222.STATE_AFTER;
    ignored: Set<string>;
    since: SyncToken | null;
    to: number;
    filter: SyncFilter;
    fullState: boolean;
}
/** Build the timeline + state section of a room. */
export declare function roomTimeline(hs: Homeserver, p: SyncParams, roomId: string, since: number | null, upTo: number): Promise<{
    timeline: Record<string, any>;
    state: PDU[];
    stateAfter: PDU[];
    timelineEvents: StoredEvent[];
}>;
export declare function roomEphemeral(hs: Homeserver, p: SyncParams, roomId: string, prefetched?: Row[]): Promise<Record<string, any>[]>;
export declare function roomSummary(hs: Homeserver, roomId: string, userId: string): Promise<Record<string, any>>;
export declare function registerSyncRoutes(r: Router): void;
export {};
