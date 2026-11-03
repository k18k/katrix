import { type PDU } from "#core/events.ts";
/** Event lookup used by state resolution (timeline events and outliers). */
export type EventSource = (eventIds: string[]) => Promise<Map<string, PDU>>;
/** A state map of (type, state_key) → event ID. */
export type StateIds = Record<string, string>;
/**
 * State resolution v2 (and v2.1 for room version 12).
 * `createEvent` is required for v12, where the create event is not in auth_events.
 */
export declare function resolveState(stateSets: StateIds[], roomVersion: string, source: EventSource, createEvent?: PDU): Promise<StateIds>;
