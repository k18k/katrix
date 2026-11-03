import { type PDU } from "#core/events.ts";
import type { Homeserver } from "#homeserver.ts";
import type { Router } from "#http/router.ts";
export declare function relationshipOf(pdu: PDU): {
    event_id: string;
    rel_type: string;
} | null;
/** Index an event's `m.relationship` edge (idempotent). */
export declare function recordEdge(hs: Homeserver, pdu: PDU): Promise<void>;
export declare function registerRelationshipRoutes(r: Router): void;
/** Server side of `/_matrix/federation/unstable/event_relationships`. */
export declare function relationshipsForServer(hs: Homeserver, origin: string, body: unknown, authChainOf: (ids: string[]) => Promise<PDU[]>): Promise<{
    events: Record<string, any>[];
    limited: boolean;
    auth_chain: Record<string, any>[];
}>;
