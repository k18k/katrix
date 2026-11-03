import { type SigningKey } from "#core/crypto.ts";
export interface PDU {
    event_id?: string;
    room_id: string;
    sender: string;
    type: string;
    state_key?: string;
    content: Record<string, any>;
    origin_server_ts: number;
    depth: number;
    prev_events: any[];
    auth_events: any[];
    redacts?: string;
    hashes?: {
        sha256: string;
    };
    signatures?: Record<string, Record<string, string>>;
    unsigned?: Record<string, any>;
    origin?: string;
}
export interface ClientEvent {
    event_id: string;
    room_id?: string;
    sender: string;
    type: string;
    state_key?: string;
    content: Record<string, any>;
    origin_server_ts: number;
    unsigned?: Record<string, any>;
    redacts?: string;
}
export declare const STABLE_ROOM_VERSIONS: string[];
/** Experimental versions: an MSC's changes on top of a stable version. */
export declare const UNSTABLE_ROOM_VERSIONS: string[];
export declare const SUPPORTED_ROOM_VERSIONS: string[];
export declare const DEFAULT_ROOM_VERSION = "10";
/** The stable version an (experimental) room version is based on, e.g. "org.matrix.msc3757.10" → 10. */
export declare const versionNum: (v: string) => number;
export declare const roomVersionFeatures: (version: string) => {
    /** v1/v2 use server-generated event IDs and `[id, hashes]` tuples in prev/auth events. */
    legacyEventIds: boolean;
    urlSafeEventIds: boolean;
    knock: boolean;
    restricted: boolean;
    knockRestricted: boolean;
    integerPowerLevels: boolean;
    /** v11: creator is the sender of the create event; `redacts` moves into content. */
    v11: boolean;
    /**
     * v12: room ID is the create event's reference hash, the create event has no room_id and is
     * omitted from auth_events, and room creators have unlimited power.
     */
    v12: boolean;
    /** MSC3757: state keys "@user:server[_suffix]" are owned by that user. */
    ownedState: boolean;
    /** MSC3389: redactions keep m.relates_to. */
    redactionKeepsRelations: boolean;
};
/** Apply the redaction algorithm for the given room version. */
export declare function redact<T extends Record<string, any>>(event: T, roomVersion: string): T;
export declare function computeContentHash(pdu: Record<string, any>): string;
export declare function computeReferenceHash(pdu: Record<string, any>, roomVersion: string): Buffer;
/** Finalise a PDU: compute hashes, signatures and the event ID. */
export declare function finalisePdu(pdu: PDU, roomVersion: string, serverName: string, key: SigningKey): PDU;
export declare function eventIdOf(ref: any): string;
/** Convert a stored PDU into the client-server event format. */
export declare function toClientEvent(pdu: PDU, opts?: {
    includeRoomId?: boolean;
}): ClientEvent;
export declare function stripState(pdu: PDU): Record<string, any>;
export declare const stateKey: (type: string, key: string) => string;
export declare const splitStateKey: (k: string) => [string, string];
