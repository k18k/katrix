import type { Homeserver } from "#homeserver.ts";
export declare class PartialStateService {
    private readonly hs;
    private readonly partial;
    private readonly completed;
    private readonly running;
    private readonly completedStreams;
    private stopped;
    constructor(hs: Homeserver);
    isPartial(roomId: string): Promise<boolean>;
    /** Servers the joining server told us were in the room (used as destinations and resync sources). */
    servers(roomId: string): Promise<string[]>;
    /** Stream position at which the room got its full state (null if it never was partial). */
    completedAt(roomId: string): Promise<number | null>;
    /**
     * A device list update for a user we do not share a (known) room with: if they may be a member
     * of a partial-state room hosted by the sender, remember them for when the state is complete.
     */
    notePendingDeviceUpdate(userId: string, origin: string): Promise<void>;
    markPartial(roomId: string, joinEventId: string, origin: string, servers: string[]): Promise<void>;
    /** Resolve once the room has its full state (or the signal aborts / the server closes). */
    waitForFullState(roomId: string, signal?: AbortSignal): Promise<void>;
    /** Resume resyncs of rooms left partial (e.g. by a restart). */
    resume(): Promise<void>;
    stop(): void;
    startResync(roomId: string): void;
    private resync;
    private tryResync;
    private finish;
}
