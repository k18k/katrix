import type { Homeserver } from "#homeserver.ts";
export interface DelayedEventsOptions {
    /** Maximum delay a client may request, in ms. Default: 24 hours. */
    maxDelayMs?: number;
    /** Maximum pending delayed events per user. Default: 100. */
    maxPerUser?: number;
}
/**
 * Delayed events (MSC4140), used by MatrixRTC so that a call membership is removed
 * when a client disappears. Stored in the database; any instance may send a due
 * event, and deleting the row first guarantees it is sent exactly once.
 */
export declare class DelayedEventService {
    private hs;
    private timer;
    readonly maxDelayMs: number;
    readonly maxPerUser: number;
    constructor(hs: Homeserver, options?: DelayedEventsOptions);
    start(): void;
    stop(): void;
    schedule(opts: {
        userId: string;
        deviceId: string;
        roomId: string;
        type: string;
        stateKey?: string;
        content: Record<string, any>;
        delayMs: number;
        txnId?: string;
    }): Promise<string>;
    list(userId: string): Promise<Record<string, any>[]>;
    update(userId: string, delayId: string, action: string): Promise<void>;
    /** Cancel pending delayed state events for a key overwritten by someone else (MSC4140). */
    onStateEvent(roomId: string, type: string, stateKey: string, sender: string): Promise<void>;
    private tick;
    private send;
}
