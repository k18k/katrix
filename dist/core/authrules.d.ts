import { type PDU } from "#core/events.ts";
export type StateMap = Map<string, PDU>;
/** MSC3757: the user owning a state key of the form "@user:server" or "@user:server_suffix". */
export declare function ownerOfStateKey(stateKeyValue: string): string | null;
export declare function getState(state: StateMap, type: string, key?: string): PDU | undefined;
export declare function membershipOf(state: StateMap, userId: string): string;
export declare function roomCreator(state: StateMap, roomVersion: string): string | undefined;
/** v12+: the create event's sender plus `additional_creators`. Empty for older versions. */
export declare function roomCreators(state: StateMap, roomVersion: string): Set<string>;
export declare const MAX_POWER_LEVEL: number;
export interface PowerLevels {
    /** v12+: users with unlimited power. */
    creators: Set<string>;
    users: Record<string, number>;
    users_default: number;
    events: Record<string, number>;
    events_default: number;
    state_default: number;
    ban: number;
    kick: number;
    redact: number;
    invite: number;
    notifications: Record<string, number>;
}
export declare function powerLevels(state: StateMap, roomVersion: string): PowerLevels;
export declare function userLevel(pl: PowerLevels, userId: string): number;
export declare function requiredLevel(pl: PowerLevels, type: string, isState: boolean): number;
export interface AuthCheckOptions {
    /** Whether a `join_authorised_via_users_server` join is signed by that user's server (checked by the caller). */
    joinAuthorisedSignatureValid?: boolean;
}
/** The (type, state_key) pairs an event's auth_events may reference (spec "auth events selection"). */
export declare function authEventKeys(event: {
    type: string;
    sender: string;
    state_key?: string;
    content: Record<string, any>;
}, roomVersion: string): string[];
/**
 * Build the auth state for an event from its auth_events, validating rule 2 of the
 * authorization rules (no duplicates, only expected types). For v12 the create event
 * (identified by the room ID) must be supplied separately.
 */
export declare function authStateFromAuthEvents(event: PDU, authEvents: PDU[], roomVersion: string, createEvent?: PDU): StateMap;
/**
 * The Matrix authorization rules: throws M_FORBIDDEN if `event` is not allowed
 * given `state` (either its auth events or the state before it).
 */
export declare function checkAuth(event: PDU, state: StateMap, roomVersion: string, opts?: AuthCheckOptions): void;
