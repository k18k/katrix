import type { Homeserver } from "#homeserver.ts";
/**
 * Outbound transaction queue backed by the database (`federation_outbox`), so any
 * instance can enqueue and pending items survive restarts. Per destination, one
 * instance at a time (cluster lock) builds and sends transactions. Failed
 * destinations back off; ephemeral EDUs (typing, presence) are dropped on failure.
 */
export declare class TransactionSender {
    private hs;
    private timers;
    private sweepTimer;
    constructor(hs: Homeserver);
    /** Start background sweeping for destinations with pending items (e.g. after a restart). */
    start(): void;
    private sweep;
    sendPdu(destinations: Iterable<string>, pdu: Record<string, any>): Promise<void>;
    sendEdu(destinations: Iterable<string>, eduType: string, content: Record<string, any>, durable?: boolean): Promise<void>;
    private enqueue;
    private schedule;
    private flush;
    /** Retry a destination immediately (e.g. after it contacted us). */
    wake(destination: string): Promise<void>;
    stop(): void;
}
