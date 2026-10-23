import type { Homeserver } from "../homeserver.ts";

/**
 * The long-poll loop of `/sync` and sliding sync: build a response up to the current stream
 * position, and while it has nothing new, wait for a change for `userId` and build again.
 *
 * https://github.com/k18k/matrix-nodejs-homeserver/issues/50: after a build with nothing new, the
 * loop used to build again whenever the server-wide position had moved, which under load is
 * always, so waiting requests rebuilt back to back. Now it registers for the user's wake-ups
 * before reading the position, so none is missed during a build, and otherwise sleeps. A wake-up
 * says which position its change has; if the next build cannot see it yet (another write in
 * flight holds the position back), the loop waits for the position to get there.
 *
 * `build(to)` returns whether the response is final (`done`); returns the last built value, the
 * position it was built at, and whether the request was aborted while waiting.
 */
export async function longPoll<T>(
  hs: Homeserver,
  userId: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  build: (to: number) => Promise<{ value: T; done: boolean }>,
): Promise<{ value: T; to: number; aborted: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let pending = 0;
  for (;;) {
    const listener = hs.notifier.listen(userId);
    pending = Math.max(pending, listener.recent);
    let to: number;
    let built: { value: T; done: boolean };
    try {
      to = await hs.streams.position();
      // A change we were told about is not in the cached position yet: read it afresh.
      if (pending > to) to = await hs.streams.position(true);
      built = await build(to);
    } catch (err) {
      listener.cancel();
      throw err;
    }
    if (pending <= to) pending = 0;
    const remaining = deadline - Date.now();
    if (built.done || remaining <= 0 || signal?.aborted) {
      listener.cancel();
      return { value: built.value, to, aborted: !!signal?.aborted };
    }
    if (pending > to) {
      // Woken for a change that is not visible yet: wait until it is, then build again.
      listener.cancel();
      if (await hs.streams.waitFor(pending, remaining, signal)) continue;
      return { value: built.value, to, aborted: !!signal?.aborted };
    }
    const woke = await listener.wait(remaining, signal);
    if (woke === null) return { value: built.value, to, aborted: !!signal?.aborted };
    pending = Math.max(pending, woke);
  }
}
