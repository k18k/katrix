import type { Homeserver } from "#homeserver.ts";
/**
 * Ephemeral typing notifications. Changes are replicated to every instance via the
 * cluster adapter; each instance keeps the typing set in memory.
 */
export declare class TypingService {
    private hs;
    private rooms;
    constructor(hs: Homeserver);
    setTyping(roomId: string, userId: string, typing: boolean, timeoutMs?: number): Promise<void>;
    private apply;
    /** Typing users in a room if they changed after `since` (or always when `since` is null). */
    typingSince(roomId: string, since: number | null): string[] | null;
}
