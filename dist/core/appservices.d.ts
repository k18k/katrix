import { type PDU } from "#core/events.ts";
import type { StateMap } from "#core/authrules.ts";
import type { Homeserver } from "#homeserver.ts";
import { UNSTABLE } from "#core/m.ts";
export interface AppServiceNamespace {
    exclusive: boolean;
    regex: string;
}
/** An application service registration (bridges, bots, integrations). */
export interface AppServiceRegistration {
    id: string;
    /** Base URL of the application service, or null when it receives nothing. */
    url: string | null;
    as_token: string;
    hs_token: string;
    sender_localpart: string;
    namespaces: {
        users?: AppServiceNamespace[];
        aliases?: AppServiceNamespace[];
        rooms?: AppServiceNamespace[];
    };
    rate_limited?: boolean;
    protocols?: string[];
    /** MSC2409: also push ephemeral events (typing, receipts, presence). */
    [UNSTABLE.DE.SORUNOME.MSC2409.PUSH_EPHEMERAL]?: boolean;
    receive_ephemeral?: boolean;
}
/**
 * Parse an application service registration file. Accepts JSON or the YAML subset
 * used by registration files (nested mappings and lists of mappings, scalars).
 */
export declare function parseAppServiceRegistration(text: string): AppServiceRegistration;
/** Load every *.yaml / *.yml / *.json registration in a directory. */
export declare function loadAppServiceRegistrations(directory: string): Promise<AppServiceRegistration[]>;
/** Application Service API: authentication, namespaces, event push and queries. */
export declare class AppServiceService {
    private hs;
    private services;
    private timers;
    constructor(hs: Homeserver, registrations: AppServiceRegistration[]);
    get registrations(): AppServiceRegistration[];
    byToken(token: string): AppServiceRegistration | null;
    byId(id: string): AppServiceRegistration | null;
    senderOf(reg: AppServiceRegistration): string;
    private compiled;
    /** Whether the AS owns this user ID (its sender or its user namespace). */
    isInterestedUser(reg: AppServiceRegistration, userId: string): boolean;
    /** An exclusive namespace owned by some AS (other than `except`) covers this user ID. */
    exclusiveUserOwner(userId: string): AppServiceRegistration | null;
    exclusiveAliasOwner(alias: string): AppServiceRegistration | null;
    /** Resolve the user an AS request acts as (masquerading with `user_id`). */
    masquerade(reg: AppServiceRegistration, userIdParam: string | null): Promise<string>;
    private interestedInEvent;
    /** Queue an event for every interested application service. */
    onEvent(pdu: PDU, state: StateMap): Promise<void>;
    /** Queue an ephemeral event (typing/receipt/presence) for interested services that asked for them. */
    onEphemeral(roomId: string | null, event: Record<string, any>, users: string[]): Promise<void>;
    private enqueue;
    private schedule;
    private retries;
    private flush;
    start(): void;
    stop(): void;
    private query;
    /** Ask the owning AS whether a user exists (it may create it). */
    queryUser(userId: string): Promise<boolean>;
    /** Ask the owning AS about an alias; returns the room ID if it now exists. */
    queryAlias(alias: string): Promise<string | null>;
    ping(reg: AppServiceRegistration, transactionId?: string): Promise<number>;
    thirdParty(path: string, query: URLSearchParams): Promise<unknown[]>;
    protocols(): Promise<Record<string, unknown>>;
}
