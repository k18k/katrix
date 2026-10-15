import { randomString } from "./crypto.ts";

/**
 * Coordination between homeserver instances sharing one database. The default
 * (`localCluster()`) keeps everything in process; use `postgresCluster()` or
 * `redisCluster()` to run several instances behind a load balancer.
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
    if (e.expires && e.expires < Date.now()) { kv.delete(key); return undefined; }
    return e;
  };
  return {
    async nextId(seq) {
      const v = (sequences.get(seq) ?? 0) + 1;
      sequences.set(seq, v);
      return v;
    },
    async currentId(seq) { return sequences.get(seq) ?? 0; },
    async advance(seq, value) { if (value > (sequences.get(seq) ?? 0)) sequences.set(seq, value); },
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
    async get(key) { return (live(key)?.value ?? null) as any; },
    async set(key, value, ttlMs) { kv.set(key, { value, expires: ttlMs ? Date.now() + ttlMs : 0 }); },
    async setIfAbsent(key, value, ttlMs) {
      if (live(key)) return false;
      kv.set(key, { value, expires: ttlMs ? Date.now() + ttlMs : 0 });
      if (kv.size > 200_000) for (const k of kv.keys()) { if (!live(k)) kv.delete(k); }
      return true;
    },
    async delete(key) { kv.delete(key); },
    async entries(prefix) {
      const out: [string, any][] = [];
      for (const k of [...kv.keys()]) if (k.startsWith(prefix)) { const e = live(k); if (e) out.push([k, e.value]); }
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
  private published: { busy: boolean; pos: number } = { busy: false, pos: 0 };
  private transition: Promise<void> = Promise.resolve();
  private heartbeat: ReturnType<typeof setInterval>;
  private positionCache: { value: number; at: number } | null = null;

  constructor(cluster: ClusterAdapter, instanceId: string) {
    this.cluster = cluster;
    this.instanceId = instanceId;
    this.heartbeat = setInterval(() => void this.publishState().catch(() => {}), WRITER_TTL_MS / 3);
    this.heartbeat.unref?.();
  }

  private key() { return `writer:${this.instanceId}`; }

  private async publishState(): Promise<void> {
    await this.cluster.set(this.key(), this.published, WRITER_TTL_MS);
  }

  /** Allocate a position. The caller must call `done()` once its writes are committed. */
  async allocate(): Promise<StreamLease> {
    // Become "busy" (with a conservative position) before allocating, so readers never overtake us.
    await (this.transition = this.transition.then(async () => {
      if (!this.published.busy) {
        this.published = { busy: true, pos: await this.cluster.currentId("stream") };
        await this.publishState();
      }
    }));
    const id = await this.cluster.nextId("stream");
    this.inflight.add(id);
    let finished = false;
    const timer = setTimeout(() => void lease.done(), 60_000);
    timer.unref?.();
    const lease: StreamLease = {
      id,
      done: async () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.inflight.delete(id);
        await (this.transition = this.transition.then(async () => {
          this.published = this.inflight.size
            ? { busy: true, pos: Math.min(...this.inflight) - 1 }
            : { busy: false, pos: await this.cluster.currentId("stream") };
          await this.publishState();
        }));
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

  /** The highest position below which everything is persisted, cluster-wide. */
  async position(): Promise<number> {
    if (this.positionCache && Date.now() - this.positionCache.at < 20) return this.positionCache.value;
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
