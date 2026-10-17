import { randomString } from "#core/crypto.ts";

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
export function localCluster(): ClusterAdapter {
  const sequences = new Map<string, number>();
  const locks = new Map<string, Promise<unknown>>();
  const handlers = new Map<string, Set<(m: any) => void>>();
  const kv = new Map<string, { value: unknown; expires: number }>();
  const live = (key: string) => {
    const e = kv.get(key);
    if (!e) return undefined;
    if (e.expires && e.expires < Date.now()) {
      kv.delete(key);
      return undefined;
    }
    return e;
  };
  return {
    async nextId(seq) {
      const v = (sequences.get(seq) ?? 0) + 1;
      sequences.set(seq, v);
      return v;
    },
    async currentId(seq) {
      return sequences.get(seq) ?? 0;
    },
    async advance(seq, value) {
      if (value > (sequences.get(seq) ?? 0)) sequences.set(seq, value);
    },
    async lock(key, fn) {
      const prev = locks.get(key) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      const settled = run.catch(() => {});
      locks.set(key, settled);
      try {
        return await run;
      } finally {
        if (locks.get(key) === settled) locks.delete(key);
      }
    },
    async publish(channel, message) {
      for (const h of handlers.get(channel) ?? []) queueMicrotask(() => h(message));
    },
    subscribe(channel, handler) {
      let set = handlers.get(channel);
      if (!set) handlers.set(channel, (set = new Set()));
      set.add(handler);
    },
    async get(key) {
      return (live(key)?.value ?? null) as any;
    },
    async set(key, value, ttlMs) {
      kv.set(key, { value, expires: ttlMs ? Date.now() + ttlMs : 0 });
    },
    async setIfAbsent(key, value, ttlMs) {
      if (live(key)) return false;
      kv.set(key, { value, expires: ttlMs ? Date.now() + ttlMs : 0 });
      if (kv.size > 200_000)
        for (const k of kv.keys()) {
          if (!live(k)) kv.delete(k);
        }
      return true;
    },
    async delete(key) {
      kv.delete(key);
    },
    async entries(prefix) {
      const out: [string, any][] = [];
      // oxlint-disable-next-line unicorn/no-useless-spread -- copy on purpose: the loop removes entries
      for (const k of [...kv.keys()])
        if (k.startsWith(prefix)) {
          const e = live(k);
          if (e) out.push([k, e.value]);
        }
      return out;
    },
  };
}

export interface StreamLease {
  id: number;
  /** Mark the position as persisted (or abandoned). */
  done(): Promise<void>;
}

const WRITER_TTL_MS = 30_000;

/**
 * A stream position held longer than this holds back /sync for everyone: it is logged with where
 * it was allocated (https://github.com/k18k/matrix-nodejs-homeserver/issues/48).
 */
const SLOW_LEASE_MS = 5_000;

/**
 * Stream positions with multiple writers. Positions are allocated from a global
 * sequence; readers only see positions up to which every writer has finished, so
 * an event committed late with a lower position can never be skipped by /sync.
 *
 * Each writer publishes `{ busy, pos }`: when busy, all of its positions ≤ pos are
 * persisted. Readers use min(global, busy writers' pos).
 */
export class StreamManager {
  private cluster: ClusterAdapter;
  private instanceId: string;
  private inflight = new Set<number>();
  /** Allocations waiting for a publish that covers them. */
  private reserving = 0;
  /** Allocations whose publish is done, asking the sequence for their position now. */
  private allocating = 0;
  /** The position of the last published busy state: below every position still being allocated. */
  private lastPos = 0;
  private heartbeat: ReturnType<typeof setInterval>;
  private positionCache: { value: number; at: number } | null = null;
  private highestAllocated = 0;
  // https://github.com/k18k/matrix-nodejs-homeserver/issues/30: every allocation from idle and every
  // completion used to append to one chain of round trips (read the sequence, write the state),
  // so all stream writes of an instance completed one at a time. Publishes are now shared: a
  // caller waits for the next publish that starts after its change, and everyone who changed
  // state before that publish started rides on it (group commit). Publishes still run one after
  // another, so a newer state is never overwritten by an older one.
  private publishing: Promise<void> = Promise.resolve();
  private nextPublish: Promise<void> | null = null;

  private warn: (...args: unknown[]) => void;

  constructor(cluster: ClusterAdapter, instanceId: string, warn: (...args: unknown[]) => void = () => {}) {
    this.cluster = cluster;
    this.instanceId = instanceId;
    this.warn = warn;
    this.heartbeat = setInterval(() => void this.flush().catch(() => {}), WRITER_TTL_MS / 3);
    this.heartbeat.unref?.();
  }

  private key() {
    return `writer:${this.instanceId}`;
  }

  /** Publish this writer's state as it is when the publish starts; concurrent callers share it. */
  private flush(): Promise<void> {
    if (this.nextPublish) return this.nextPublish;
    const run = async () => {
      // From here on, changes need a later publish. The reservations so far are covered by this
      // one: once it is out, they go on to take their positions.
      this.nextPublish = null;
      const covered = this.reserving;
      const earlier = this.allocating;
      this.reserving = 0;
      this.allocating += covered;
      // The published position must be below every position not yet persisted:
      // - in flight: below the lowest one;
      // - allocations covered by an earlier publish may be taking positions right now: that
      //   publish's position is below them;
      // - the ones covered now take theirs after this publish: the sequence as it is now.
      const bounds: number[] = [];
      if (this.inflight.size) bounds.push(Math.min(...this.inflight) - 1);
      if (earlier) bounds.push(this.lastPos);
      if (covered) bounds.push(await this.cluster.currentId("stream"));
      const state = bounds.length ? { busy: true, pos: Math.min(...bounds) } : { busy: false, pos: 0 };
      if (state.busy) this.lastPos = state.pos;
      await this.cluster.set(this.key(), state, WRITER_TTL_MS);
    };
    const p = this.publishing.then(run, run);
    this.nextPublish = p;
    this.publishing = p.catch(() => {});
    return p;
  }

  /** Allocate a position. The caller must call `done()` once its writes are committed. */
  async allocate(): Promise<StreamLease> {
    // Be published as busy (with a position below anything we allocate) before allocating, so
    // readers never overtake us. The publish moves this reservation to `allocating`.
    this.reserving++;
    let id: number;
    try {
      await this.flush();
      id = await this.cluster.nextId("stream");
      this.inflight.add(id);
      if (id > this.highestAllocated) this.highestAllocated = id;
    } finally {
      this.allocating--;
    }
    let finished = false;
    // Where the position was allocated, for the slow-lease warning (#48). The stack is only
    // formatted if the warning is logged.
    const site = new Error("stream position allocated here");
    const slow = setTimeout(
      () => this.warn(`Stream position ${id} held for over ${SLOW_LEASE_MS} ms; /sync waits for it`, site),
      SLOW_LEASE_MS,
    );
    slow.unref?.();
    const timer = setTimeout(() => void lease.done(), 60_000);
    timer.unref?.();
    const lease: StreamLease = {
      id,
      done: async () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(slow);
        this.inflight.delete(id);
        await this.flush();
        this.positionCache = null;
      },
    };
    return lease;
  }

  /** Allocate a position, run `fn` with it, then complete it. */
  async write<T>(fn: (id: number) => Promise<T>): Promise<T> {
    const lease = await this.allocate();
    try {
      return await fn(lease.id);
    } finally {
      await lease.done();
    }
  }

  /** A fresh decreasing position for backfilled (historical) events. */
  async backfillId(): Promise<number> {
    return -(await this.cluster.nextId("backfill"));
  }

  /** The highest position this instance has allocated: an upper bound of its changes so far. */
  get lastAllocated(): number {
    return this.highestAllocated;
  }

  /**
   * The highest position below which everything is persisted, cluster-wide. `fresh` skips the
   * 20 ms cache, for a caller that knows a change has completed elsewhere.
   */
  async position(fresh = false): Promise<number> {
    if (!fresh && this.positionCache && Date.now() - this.positionCache.at < 20) return this.positionCache.value;
    // Read the global sequence first, then the writers (see class comment).
    const global = await this.cluster.currentId("stream");
    let pos = global;
    for (const [, w] of await this.cluster.entries<{ busy: boolean; pos: number }>("writer:")) {
      if (w?.busy) pos = Math.min(pos, w.pos);
    }
    if (this.inflight.size) pos = Math.min(pos, Math.min(...this.inflight) - 1);
    this.positionCache = { value: pos, at: Date.now() };
    return pos;
  }

  /**
   * Resolve once the position has reached `pos` (true), or false after `timeoutMs` or on abort.
   * For a request woken by a change that another write in flight still keeps out of sight
   * (https://github.com/k18k/matrix-nodejs-homeserver/issues/50). It checks again at growing
   * intervals: writes finish in milliseconds, and the position may be held by another instance.
   */
  async waitFor(pos: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let delay = 5;
    for (;;) {
      if ((await this.position(true)) >= pos) return true;
      const left = deadline - Date.now();
      if (left <= 0 || signal?.aborted) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, left)));
      delay = Math.min(delay * 2, 200);
    }
  }

  async advanceTo(value: number): Promise<void> {
    await this.cluster.advance("stream", value);
  }

  async lowerBackfillTo(value: number): Promise<void> {
    if (value < 0) await this.cluster.advance("backfill", -value);
  }

  async stop(): Promise<void> {
    clearInterval(this.heartbeat);
    await this.cluster.delete(this.key()).catch(() => {});
  }
}

export function newInstanceId(): string {
  return `${process.pid}-${randomString(8)}`;
}
