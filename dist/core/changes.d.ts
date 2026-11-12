import { DatabaseAdapter } from "../storage/types.js";
/**
 * Where keys last changed, for a homeserver that is the only instance on its database.
 *
 * https://github.com/k18k/katrix/issues/51: most of a `/sync` build asked the
 * database whether something had changed since the token (to-device messages, presence, account
 * data, the user's rooms) and almost always found nothing. Every write passes through the adapter
 * returned by `ChangeTracker.wrap`, which notes, per key, the stream position (or, for cached
 * values, the write) at which it last changed, so `/sync` knows without asking.
 *
 * It is only used without a cluster adapter: another instance's writes would not pass through it.
 * Memory is bounded: each log keeps its most recently changed keys, and forgetting a key raises
 * the log's floor, at or below which every key counts as changed (and the database is asked).
 */
export declare class ChangeLog {
  private latest;
  private floor;
  private max;
  constructor(max: number, floor?: number);
  /** `key` changed at `pos`. */
  record(key: string, pos: number): void;
  /** Every key may have changed at or below `pos` (for writes whose keys are not known). */
  raiseFloor(pos: number): void;
  /** Set the floor (also lower it: from "nothing is known" to a starting position). */
  setFloor(pos: number): void;
  /** Whether `key` may have changed after `pos`; false only when it is known not to have. */
  changedAfter(key: string, pos: number): boolean;
  /** The keys among `keys` that may have changed after `pos`. */
  filterChanged(keys: Iterable<string>, pos: number): string[];
}
/**
 * Values read from the database, kept until a write changes their key. A value is only kept if
 * no write to its key started while it was being read; in a transaction, the keys are marked
 * again once it commits, so a value read before the commit is not kept either.
 */
export declare class ValueCache<V> {
  private values;
  private writes;
  private clock;
  private max;
  constructor(max: number, clock: () => number);
  /** A write to `key` (or, without a key, to any) has started or finished at `tick`. */
  written(key: string | null, tick: number): void;
  /** The kept value of `key`, if there is one and no write has changed it since it was read. */
  peek(key: string): V | undefined;
  /**
   * Keep `value`, read by a read that began at `readAt` (the clock then): unless a write to `key`
   * began since, which may or may not be in `value`.
   */
  store(key: string, value: V, readAt: number): void;
  get(key: string, load: () => Promise<V>): Promise<V>;
}
/** Stream logs: keys that changed at a stream position. */
export type StreamLogName = "toDevice" | "presence" | "deviceLists" | "accountData" | "roomEvents" | "roomReceipts" | "roomMembers" | "roomPartialState";
/** Value caches: values kept until their key is written. */
export type ValueName = "userMemberships" | "ignoredUsers" | "oneTimeKeys" | "fallbackKeys" | "presenceRow" | "readReceipts" | "unreadCounts";
export declare class ChangeTracker {
  readonly logs: Record<StreamLogName, ChangeLog>;
  readonly values: Record<ValueName, ValueCache<any>>;
  private tick;
  constructor();
  /**
   * Begin answering for changes after `position`. Until then, every key counts as changed. Every
   * write after the adapter was wrapped is noted, so the logs know all changes after `position`
   * if it was read after wrapping.
   */
  start(position: number): void;
  /** The clock to pass to `ValueCache.store` for a read that begins now. */
  now(): number;
  /** Note a write to `model`: `rows` written, or rows matching `where` changed or deleted. */
  private note;
  /** Mark cached values written again (after a transaction committed). */
  private rewritten;
  /** An adapter that notes every write before passing it on to `db`. */
  wrap(db: DatabaseAdapter): DatabaseAdapter;
  private wrapWith;
}
//# sourceMappingURL=changes.d.ts.map