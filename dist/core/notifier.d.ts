import { ClusterAdapter } from "./cluster.js";
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
export declare class Notifier {
  private listeners;
  /** Each user's latest wake-up position, oldest first (re-inserted on update). */
  private recent;
  private cluster;
  private instanceId;
  private lastAllocated;
  private position;
  /** Reports a wake-up that could not be published to other instances; the homeserver sets it to its logger. */
  warn: (...args: unknown[]) => void;
  /** Wake-ups whose change is beyond the position known to be visible. */
  private held;
  /** The highest position known to be visible. */
  private visible;
  private release;
  /**
   * `lastAllocated`: the highest stream position this instance has allocated (an upper bound of
   * its changes); `position`: the position below which everything is visible.
   */
  constructor(cluster: ClusterAdapter, instanceId: string, lastAllocated?: () => number, position?: (fresh: boolean) => Promise<number>);
  /**
   * Wake `userIds`. `pos` is the stream position of the change; without it, the highest position
   * this instance has allocated stands in, which is never below it.
   */
  notify(userIds: Iterable<string>, pos?: number): void;
  /** The position may have moved (a write of this instance completed): release what it covers. */
  advanced(): void;
  /** Wake now if the change is visible, otherwise once the position reaches it. */
  private hold;
  private scheduleRelease;
  private releaseHeld;
  private wakeLocal;
  notifyAll(): void;
  listen(userId: string): Listener;
  /** Wait for a wake-up of `userId` (for callers that do not track positions). */
  wait(userId: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
}
//# sourceMappingURL=notifier.d.ts.map