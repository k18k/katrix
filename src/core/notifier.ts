import type { ClusterAdapter } from "#core/cluster.ts";

/** Users whose latest wake-up position is remembered (#50); the oldest are forgotten first. */
const RECENT_USERS = 100_000;

/** A registration for wake-ups from the moment it was made (see `Notifier.listen`). */
export interface Listener {
  /**
   * The stream position of this user's latest wake-up before the listener was registered (0 if
   * none is remembered): the change may not have been visible to the build that preceded it.
   */
  readonly recent: number;
  /**
   * Resolve with the position of the first wake-up since registration (at once if there was one
   * already), or null after `timeoutMs` or on abort.
   */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<number | null>;
  /** Stop listening; a pending `wait` resolves with null. */
  cancel(): void;
}

/**
 * Wakes long-polling `/sync` requests when something relevant happens. Notifications
 * are broadcast through the cluster adapter so waiters on other instances wake too.
 *
 * https://github.com/k18k/matrix-nodejs-homeserver/issues/50: every wake-up carries the stream
 * position of its change, or an upper bound of it. A request that wakes but finds nothing new
 * (because another write still holds the position back) knows which position to wait for,
 * instead of rebuilding whenever anything on the server moves the position.
 */
export class Notifier {
  private listeners = new Map<string, Set<(pos: number) => void>>();
  /** Each user's latest wake-up position, oldest first (re-inserted on update). */
  private recent = new Map<string, number>();
  private cluster: ClusterAdapter;
  private instanceId: string;
  private lastAllocated: () => number;

  /** `lastAllocated`: the highest stream position this instance has allocated (an upper bound). */
  constructor(cluster: ClusterAdapter, instanceId: string, lastAllocated: () => number = () => 0) {
    this.cluster = cluster;
    this.instanceId = instanceId;
    this.lastAllocated = lastAllocated;
    cluster.subscribe("notify", (msg: { from: string; users: string[]; pos?: number }) => {
      if (msg?.from !== this.instanceId && Array.isArray(msg?.users)) this.wakeLocal(msg.users, Number(msg.pos) || 0);
    });
  }

  /**
   * Wake `userIds`. `pos` is the stream position of the change; without it, the highest position
   * this instance has allocated stands in, which is never below it.
   */
  notify(userIds: Iterable<string>, pos?: number): void {
    const users = [...userIds];
    if (!users.length) return;
    const at = pos ?? this.lastAllocated();
    this.wakeLocal(users, at);
    void this.cluster.publish("notify", { from: this.instanceId, users, pos: at }).catch(() => {});
  }

  private wakeLocal(userIds: Iterable<string>, pos: number): void {
    for (const u of userIds) {
      const previous = this.recent.get(u) ?? 0;
      this.recent.delete(u);
      this.recent.set(u, Math.max(previous, pos));
      if (this.recent.size > RECENT_USERS) this.recent.delete(this.recent.keys().next().value!);
      const set = this.listeners.get(u);
      if (!set) continue;
      this.listeners.delete(u);
      for (const wake of set) wake(pos);
    }
  }

  notifyAll(): void {
    // Deleting the entry being visited is safe while iterating a Map.
    for (const [u, set] of this.listeners) {
      this.listeners.delete(u);
      for (const wake of set) wake(0);
    }
  }

  listen(userId: string): Listener {
    let woken: number | null = null;
    let resolveWait: ((pos: number | null) => void) | null = null;
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    const onWake = (pos: number) => {
      woken = Math.max(woken ?? 0, pos);
      resolveWait?.(woken);
    };
    set.add(onWake);
    const remove = () => {
      const current = this.listeners.get(userId);
      current?.delete(onWake);
      if (current && current.size === 0) this.listeners.delete(userId);
    };
    return {
      recent: this.recent.get(userId) ?? 0,
      wait: (timeoutMs, signal) => {
        if (woken !== null) return Promise.resolve(woken);
        return new Promise((resolve) => {
          const done = (result: number | null) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", aborted);
            resolveWait = null;
            remove();
            resolve(result);
          };
          const aborted = () => done(null);
          const timer = setTimeout(() => done(null), timeoutMs);
          signal?.addEventListener("abort", aborted, { once: true });
          resolveWait = (pos) => done(pos);
        });
      },
      cancel: () => {
        remove();
        resolveWait?.(null);
      },
    };
  }

  /** Wait for a wake-up of `userId` (for callers that do not track positions). */
  async wait(userId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await this.listen(userId).wait(timeoutMs, signal);
  }
}
