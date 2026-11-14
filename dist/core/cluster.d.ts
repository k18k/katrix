/**
 * Coordination between homeserver instances sharing one database. The default
 * (`localCluster()`) keeps everything in process; use `postgresCluster()` to run several
 * instances behind a load balancer.
 */
export interface ClusterAdapter {
  /** Allocate the next value of a cluster-wide, strictly increasing sequence. */
  nextId(sequence: string): Promise<number>;
  /** Current (latest allocated) value of a sequence. */
  currentId(sequence: string): Promise<number>;
  /** Ensure a sequence is at least `value` (used at startup with existing data). */
  advance(sequence: string, value: number): Promise<void>;
  /** Run `fn` while holding a cluster-wide mutex for `key`. */
  lock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: (message: any) => void): void;
  /** Ephemeral shared key-value storage. */
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  /** Set only if the key is absent (or expired). Returns true when the value was set. */
  setIfAbsent(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** All live entries whose key starts with `prefix`. */
  entries<T = unknown>(prefix: string): Promise<[string, T][]>;
  close?(): Promise<void>;
}
/** In-process cluster adapter: a single homeserver instance. */
export declare function localCluster(): ClusterAdapter;
export interface StreamLease {
  id: number;
  /** Mark the position as persisted (or abandoned). */
  done(): Promise<void>;
}
/**
 * Stream positions with multiple writers. Positions are allocated from a global
 * sequence; readers only see positions up to which every writer has finished, so
 * an event committed late with a lower position can never be skipped by /sync.
 *
 * Each writer publishes `{ busy, pos }`: when busy, all of its positions ≤ pos are
 * persisted. Readers use min(global, busy writers' pos).
 */
export declare class StreamManager {
  private cluster;
  private instanceId;
  private inflight;
  /** Allocations waiting for a publish that covers them. */
  private reserving;
  /** Allocations whose publish is done, asking the sequence for their position now. */
  private allocating;
  /** The position of the last published busy state: below every position still being allocated. */
  private lastPos;
  private heartbeat;
  private positionCache;
  /** Counts completed writes of this instance: a position read that began before the latest one may not show it. */
  private gen;
  /** The position read in flight, and the one queued to start after it (see `position`). */
  private reading;
  private queuedRead;
  private highestAllocated;
  /** Called after a write of this instance completed, when the position may have moved (#50). */
  onAdvance: () => void;
  private publishing;
  private nextPublish;
  private warn;
  constructor(cluster: ClusterAdapter, instanceId: string, warn?: (...args: unknown[]) => void);
  private key;
  /** Publish this writer's state as it is when the publish starts; concurrent callers share it. */
  private flush;
  /** Allocate a position. The caller must call `done()` once its writes are committed. */
  allocate(): Promise<StreamLease>;
  /** Allocate a position, run `fn` with it, then complete it. */
  write<T>(fn: (id: number) => Promise<T>): Promise<T>;
  /** A fresh decreasing position for backfilled (historical) events. */
  backfillId(): Promise<number>;
  /** The highest position this instance has allocated: an upper bound of its changes so far. */
  get lastAllocated(): number;
  /**
   * The highest position below which everything is persisted, cluster-wide. `fresh` skips the
   * 20 ms cache, for a caller that knows a change has completed elsewhere.
   */
  position(fresh?: boolean): Promise<number>;
  private readPosition;
  private readPositionNow;
  /**
   * Resolve once the position has reached `pos` (true), or false after `timeoutMs` or on abort.
   * For a request woken by a change that another write in flight still keeps out of sight
   * (https://github.com/k18k/katrix/issues/50). It checks again at growing
   * intervals: writes finish in milliseconds, and the position may be held by another instance.
   */
  waitFor(pos: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  advanceTo(value: number): Promise<void>;
  lowerBackfillTo(value: number): Promise<void>;
  stop(): Promise<void>;
}
//# sourceMappingURL=cluster.d.ts.map