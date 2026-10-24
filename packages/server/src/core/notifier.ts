import type { ClusterAdapter } from "#core/cluster.ts";

/** Users whose latest wake-up position is remembered (#50); the oldest are forgotten first. */
const RECENT_USERS = 100_000;
/** How soon held wake-ups are looked at again while the position has not reached them. */
const RELEASE_RETRY_MS = 10;

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
 * https://github.com/k18k/katrix/issues/50: every wake-up carries the stream
 * position of its change, or an upper bound of it. Writes can complete out of order, so a change
 * may be committed while an earlier write still holds the position below it. As in Synapse
 * (`Notifier._notify_pending_new_room_events`), such a wake-up is held here until the position
 * reaches it: a request is only woken for changes it can see.
 */
export class Notifier {
  private listeners = new Map<string, Set<(pos: number) => void>>();
  /** Each user's latest wake-up position, oldest first (re-inserted on update). */
  private recent = new Map<string, number>();
  private cluster: ClusterAdapter;
  private instanceId: string;
  private lastAllocated: () => number;
  private position: (fresh: boolean) => Promise<number>;
  /** Wake-ups whose change is beyond the position known to be visible. */
  private held: { users: string[]; pos: number }[] = [];
  /** The highest position known to be visible. */
  private visible = 0;
  private release: ReturnType<typeof setTimeout> | null = null;

  /**
   * `lastAllocated`: the highest stream position this instance has allocated (an upper bound of
   * its changes); `position`: the position below which everything is visible.
   */
  constructor(
    cluster: ClusterAdapter,
    instanceId: string,
    lastAllocated: () => number = () => 0,
    position: (fresh: boolean) => Promise<number> = async () => Number.POSITIVE_INFINITY,
  ) {
    this.cluster = cluster;
    this.instanceId = instanceId;
    this.lastAllocated = lastAllocated;
    this.position = position;
    cluster.subscribe("notify", (msg: { from: string; users: string[]; pos?: number }) => {
      if (msg?.from !== this.instanceId && Array.isArray(msg?.users)) this.hold(msg.users, Number(msg.pos) || 0);
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
    this.hold(users, at);
    void this.cluster.publish("notify", { from: this.instanceId, users, pos: at }).catch(() => {});
  }

  /** The position may have moved (a write of this instance completed): release what it covers. */
  advanced(): void {
    if (this.held.length) this.scheduleRelease(0);
  }

  /** Wake now if the change is visible, otherwise once the position reaches it. */
  private hold(users: string[], pos: number): void {
    if (pos <= this.visible) return this.wakeLocal(users, pos);
    this.held.push({ users, pos });
    this.scheduleRelease(0);
  }

  private scheduleRelease(delay: number): void {
    if (this.release) return;
    this.release = setTimeout(() => {
      this.release = null;
      void this.releaseHeld().catch(() => this.scheduleRelease(RELEASE_RETRY_MS));
    }, delay);
    this.release.unref?.();
  }

  private async releaseHeld(): Promise<void> {
    const highest = Math.max(...this.held.map((h) => h.pos));
    // The cached position first: it often covers everything held already.
    let pos = await this.position(false);
    if (pos < highest) pos = await this.position(true);
    if (pos > this.visible) this.visible = pos;
    const due = this.held.filter((h) => h.pos <= this.visible);
    this.held = this.held.filter((h) => h.pos > this.visible);
    for (const h of due) this.wakeLocal(h.users, h.pos);
    // Still held: a write elsewhere (another instance) keeps the position back. Look again soon.
    if (this.held.length) this.scheduleRelease(RELEASE_RETRY_MS);
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
