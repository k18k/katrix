import { randomUUID } from "node:crypto";
import type { ClusterAdapter } from "#core/cluster.ts";

export { localCluster, type ClusterAdapter } from "#core/cluster.ts";

/** Per-process queue so each instance holds at most one remote lock per key. */
function localQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.catch(() => {});
    tails.set(key, settled);
    try {
      return await run;
    } finally {
      if (tails.get(key) === settled) tails.delete(key);
    }
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  release(): void;
  on(event: "notification", listener: (msg: { channel: string; payload?: string }) => void): unknown;
}

export interface PgClusterPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  connect(): Promise<PgClientLike>;
}

const PG_CHANNEL = "matrix_cluster";
/** How long a lock lease lasts without renewal (it is renewed every third of that while held). */
const LOCK_TTL_MS = 30_000;
const MAX_NOTIFY_PAYLOAD = 7000;

/**
 * Cluster adapter backed by PostgreSQL (`pg` Pool): sequences, leased locks,
 * LISTEN/NOTIFY pub/sub and an expiring key-value table. Lets several homeserver
 * instances share one database.
 */
export function postgresCluster(pool: PgClusterPoolLike, options: { tablePrefix?: string } = {}): ClusterAdapter {
  const seq = `"${options.tablePrefix ?? ""}cluster_sequences"`;
  const kv = `"${options.tablePrefix ?? ""}cluster_kv"`;
  const handlers = new Map<string, Set<(m: any) => void>>();
  const queue = localQueue();
  let listener: PgClientLike | null = null;
  let cleanup: ReturnType<typeof setInterval> | null = null;

  const ready = (async () => {
    // CREATE TABLE IF NOT EXISTS is not safe against concurrent creators; serialise with an advisory lock.
    const setup = await pool.connect();
    try {
      await setup.query("BEGIN");
      await setup.query("SELECT pg_advisory_xact_lock(hashtextextended('matrix_cluster_setup', 0))");
      await setup.query(`CREATE TABLE IF NOT EXISTS ${seq} (name TEXT PRIMARY KEY, value BIGINT NOT NULL)`);
      await setup.query(`CREATE TABLE IF NOT EXISTS ${kv} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at BIGINT)`);
      await setup.query("COMMIT");
    } catch (err) {
      await setup.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      setup.release();
    }
    listener = await pool.connect();
    listener.on("notification", (msg) => {
      if (msg.channel !== PG_CHANNEL || !msg.payload) return;
      void (async () => {
        let parsed = JSON.parse(msg.payload!);
        if (parsed.ref) {
          const res = await pool.query(`SELECT value FROM ${kv} WHERE key = $1`, [parsed.ref]);
          if (!res.rows[0]) return;
          parsed = JSON.parse(res.rows[0].value);
        }
        for (const h of handlers.get(parsed.channel) ?? []) h(parsed.message);
      })().catch(() => {});
    });
    await listener.query(`LISTEN ${PG_CHANNEL}`);
    cleanup = setInterval(
      () => void pool.query(`DELETE FROM ${kv} WHERE expires_at IS NOT NULL AND expires_at < $1`, [Date.now()]).catch(() => {}),
      60_000,
    );
    cleanup.unref?.();
  })();
  ready.catch(() => {});

  const q = async (text: string, values?: unknown[]) => {
    await ready;
    return pool.query(text, values);
  };

  return {
    async nextId(name) {
      const res = await q(
        `INSERT INTO ${seq} (name, value) VALUES ($1, 1) ON CONFLICT (name) DO UPDATE SET value = ${seq}.value + 1 RETURNING value`,
        [name],
      );
      return Number(res.rows[0].value);
    },
    async currentId(name) {
      const res = await q(`SELECT value FROM ${seq} WHERE name = $1`, [name]);
      return res.rows[0] ? Number(res.rows[0].value) : 0;
    },
    async advance(name, value) {
      await q(
        `INSERT INTO ${seq} (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = GREATEST(${seq}.value, EXCLUDED.value)`,
        [name, value],
      );
    },
    // https://github.com/k18k/matrix-nodejs-homeserver/issues/29: this held a session advisory lock,
    // and so a pool connection, for as long as `fn` ran, while `fn` queried through the same pool.
    // With as many keys locked as the pool had connections, every connection belonged to a lock
    // owner waiting for a free one, and the server hung. A lock is now a lease in the kv table, as
    // in the Redis adapter: no connection is held, the lease is renewed while `fn` runs, and a
    // crashed owner's lease expires after LOCK_TTL_MS (an advisory lock went with its connection
    // at once; that is the price of not holding one).
    lock(key, fn) {
      return queue(key, async () => {
        await ready;
        const lockKey = `lock:${key}`;
        const token = randomUUID();
        const acquire = async () => {
          const now = Date.now();
          const res = await pool.query(
            `INSERT INTO ${kv} (key, value, expires_at) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
             WHERE ${kv}.expires_at IS NOT NULL AND ${kv}.expires_at <= $4 RETURNING key`,
            [lockKey, token, now + LOCK_TTL_MS, now],
          );
          return (res.rowCount ?? 0) > 0;
        };
        for (let delay = 5; !(await acquire()); delay = Math.min(delay * 2, 200)) await new Promise((r) => setTimeout(r, delay));
        const renew = setInterval(
          () =>
            void pool
              .query(`UPDATE ${kv} SET expires_at = $3 WHERE key = $1 AND value = $2`, [lockKey, token, Date.now() + LOCK_TTL_MS])
              .catch(() => {}),
          LOCK_TTL_MS / 3,
        );
        try {
          return await fn();
        } finally {
          clearInterval(renew);
          await pool.query(`DELETE FROM ${kv} WHERE key = $1 AND value = $2`, [lockKey, token]).catch(() => {});
        }
      });
    },
    async publish(channel, message) {
      let payload = JSON.stringify({ channel, message });
      if (payload.length > MAX_NOTIFY_PAYLOAD) {
        const ref = `pubsub:${randomUUID()}`;
        await q(`INSERT INTO ${kv} (key, value, expires_at) VALUES ($1, $2, $3)`, [ref, payload, Date.now() + 60_000]);
        payload = JSON.stringify({ ref });
      }
      await q("SELECT pg_notify($1, $2)", [PG_CHANNEL, payload]);
    },
    subscribe(channel, handler) {
      let set = handlers.get(channel);
      if (!set) handlers.set(channel, (set = new Set()));
      set.add(handler);
    },
    async get(key) {
      const res = await q(`SELECT value FROM ${kv} WHERE key = $1 AND (expires_at IS NULL OR expires_at > $2)`, [key, Date.now()]);
      return res.rows[0] ? JSON.parse(res.rows[0].value) : null;
    },
    async set(key, value, ttlMs) {
      await q(
        `INSERT INTO ${kv} (key, value, expires_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [key, JSON.stringify(value), ttlMs ? Date.now() + ttlMs : null],
      );
    },
    async setIfAbsent(key, value, ttlMs) {
      const now = Date.now();
      const res = await q(
        `INSERT INTO ${kv} (key, value, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
         WHERE ${kv}.expires_at IS NOT NULL AND ${kv}.expires_at <= $4 RETURNING key`,
        [key, JSON.stringify(value), ttlMs ? now + ttlMs : null, now],
      );
      return (res.rowCount ?? 0) > 0;
    },
    async delete(key) {
      await q(`DELETE FROM ${kv} WHERE key = $1`, [key]);
    },
    async entries(prefix) {
      const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      const res = await q(`SELECT key, value FROM ${kv} WHERE key LIKE $1 AND (expires_at IS NULL OR expires_at > $2)`, [
        `${escaped}%`,
        Date.now(),
      ]);
      return res.rows.map((r: any) => [r.key, JSON.parse(r.value)] as [string, any]);
    },
    async close() {
      if (cleanup) clearInterval(cleanup);
      if (listener) {
        await listener.query(`UNLISTEN ${PG_CHANNEL}`).catch(() => {});
        listener.release();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/** Minimal ioredis-compatible client. */
export interface RedisLike {
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
  scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

/** A Redis connection in subscriber mode (a separate connection, as Redis requires). */
export interface RedisSubscriberLike {
  subscribe(...channels: string[]): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
}

const UNLOCK = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const EXTEND = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

/**
 * Cluster adapter backed by Redis (ioredis API). Pass two connections: one for
 * commands and one dedicated to subscriptions.
 */
export function redisCluster(opts: { client: RedisLike; subscriber: RedisSubscriberLike; prefix?: string }): ClusterAdapter {
  const { client, subscriber } = opts;
  const prefix = opts.prefix ?? "matrix:";
  const channel = `${prefix}cluster`;
  const handlers = new Map<string, Set<(m: any) => void>>();
  const queue = localQueue();
  const ready = subscriber.subscribe(channel);
  subscriber.on("message", (ch, raw) => {
    if (ch !== channel) return;
    try {
      const { channel: name, message } = JSON.parse(raw);
      for (const h of handlers.get(name) ?? []) h(message);
    } catch {
      /* ignore malformed */
    }
  });
  const k = (key: string) => `${prefix}${key}`;

  return {
    async nextId(name) {
      return Number(await client.incr(k(`seq:${name}`)));
    },
    async currentId(name) {
      return Number((await client.get(k(`seq:${name}`))) ?? 0);
    },
    async advance(name, value) {
      await client.eval(
        `local v = tonumber(redis.call("get", KEYS[1]) or "0") if v < tonumber(ARGV[1]) then redis.call("set", KEYS[1], ARGV[1]) end return 1`,
        1,
        k(`seq:${name}`),
        value,
      );
    },
    lock(key, fn) {
      return queue(key, async () => {
        const lockKey = k(`lock:${key}`);
        const token = randomUUID();
        const ttl = 30_000;
        for (let delay = 5; ; delay = Math.min(delay * 2, 200)) {
          if ((await client.set(lockKey, token, "PX", ttl, "NX")) === "OK") break;
          await new Promise((r) => setTimeout(r, delay));
        }
        // Keep the lock alive while `fn` runs.
        const renew = setInterval(() => void client.eval(EXTEND, 1, lockKey, token, ttl).catch(() => {}), ttl / 3);
        try {
          return await fn();
        } finally {
          clearInterval(renew);
          await client.eval(UNLOCK, 1, lockKey, token).catch(() => {});
        }
      });
    },
    async publish(name, message) {
      await ready;
      await client.publish(channel, JSON.stringify({ channel: name, message }));
    },
    subscribe(name, handler) {
      let set = handlers.get(name);
      if (!set) handlers.set(name, (set = new Set()));
      set.add(handler);
    },
    async get(key) {
      const v = await client.get(k(`kv:${key}`));
      return v === null ? null : JSON.parse(v);
    },
    async set(key, value, ttlMs) {
      if (ttlMs) await client.set(k(`kv:${key}`), JSON.stringify(value), "PX", ttlMs);
      else await client.set(k(`kv:${key}`), JSON.stringify(value));
    },
    async setIfAbsent(key, value, ttlMs) {
      const res = ttlMs
        ? await client.set(k(`kv:${key}`), JSON.stringify(value), "PX", ttlMs, "NX")
        : await client.set(k(`kv:${key}`), JSON.stringify(value), "NX");
      return res === "OK";
    },
    async delete(key) {
      await client.del(k(`kv:${key}`));
    },
    async entries(keyPrefix) {
      const out: [string, any][] = [];
      let cursor = "0";
      const pattern = `${k(`kv:${keyPrefix}`).replace(/[*?[\]]/g, (c) => `\\${c}`)}*`;
      do {
        const [next, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 200);
        cursor = next;
        if (keys.length) {
          const values = await client.mget(...keys);
          keys.forEach((key, i) => {
            if (values[i] !== null) out.push([key.slice(k("kv:").length), JSON.parse(values[i]!)]);
          });
        }
      } while (cursor !== "0");
      return out;
    },
  };
}
