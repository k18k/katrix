import type { Homeserver } from "#homeserver.ts";
/**
 * The long-poll loop of `/sync` and sliding sync: build a response up to the current stream
 * position, and while it has nothing new, wait for a change for `userId` and build again.
 *
 * https://github.com/k18k/katrix/issues/50: after a build with nothing new, the
 * loop used to build again whenever the server-wide position had moved, which under load is
 * always, so waiting requests rebuilt back to back. Now it registers for the user's wake-ups
 * before reading the position, so none is missed during a build, and otherwise sleeps. A wake-up
 * says which position its change has; if the next build cannot see it yet (another write in
 * flight holds the position back), the loop waits for the position to get there.
 *
 * `build(to)` returns whether the response is final (`done`); returns the last built value, the
 * position it was built at, and whether the request was aborted while waiting.
 */
export declare function longPoll<T>(hs: Homeserver, userId: string, timeoutMs: number, signal: AbortSignal | undefined, build: (to: number) => Promise<{
    value: T;
    done: boolean;
}>): Promise<{
    value: T;
    to: number;
    aborted: boolean;
}>;
