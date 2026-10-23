import { randomUUID } from "node:crypto";
import { CLUSTER_RESYNC, underLease, type ClusterAdapter } from "../core/cluster.ts";
import { ignorePgError } from "../storage/sql.ts";

export { localCluster, type ClusterAdapter } from "../core/cluster.ts";

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
  /** `release(err)` closes the connection instead of returning it to the pool. */
  release(err?: Error | boolean): void;
  on(event: "notification", listener: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: "error" | "end", listener: (err?: Error) => void): unknown;
}

export interface PgClusterPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  connect(): Promise<PgClientLike>;
  on?(event: "error", listener: (err: Error) => void): unknown;
}

const PG_CHANNEL = "matrix_cluster";
/** Internal pub/sub channel announcing released locks. */
const RELEASED = "__lock_released";
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
  // Lock waiters on this instance, woken when another instance releases the lock they wait for.
  const waiting = new Map<string, Set<() => void>>();
  const releasedOrAfter = (lockKey: string, ms: number) =>
    new Promise<void>((resolve) => {
      let set = waiting.get(lockKey);
      if (!set) waiting.set(lockKey, (set = new Set()));
      const wake = () => {
        clearTimeout(timer);
        set!.delete(wake);
        if (set!.size === 0 && waiting.get(lockKey) === set) waiting.delete(lockKey);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      set.add(wake);
    });
  handlers.set(RELEASED, new Set([(lockKey: string) => [...(waiting.get(lockKey) ?? [])].forEach((wake) => wake())]));
  let listener: PgClientLike | null = null;
  // A Postgres restart must not end the process (#91, see ignorePgError).
  pool.on?.("error", ignorePgError);
  let cleanup: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const onNotification = (msg: { channel: string; payload?: string }) => {
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
  };
  // https://github.com/k18k/matrix-nodejs-homeserver/issues/92 — insufficient session expiration (CWE-613): when the
  // LISTEN connection dropped (a Postgres restart), it was never opened again, so this instance missed every later
  // revocation and cache invalidation and kept serving revoked tokens and stale state. It reconnects now, and since
  // messages sent meanwhile are lost, it tells its own subscribers to drop their caches (CLUSTER_RESYNC).
  // shortcut: a connection that dies silently (no error, no end, e.g. a network partition) is not noticed; add a
  // periodic query on the listener if that matters.
  const listen = async (): Promise<void> => {
    const client = await pool.connect();
    const lost = () => {
      if (listener !== client) return;
      listener = null;
      client.release(true);
      if (!closed) reconnect(500);
    };
    client.on("error", lost);
    client.on("end", lost);
    client.on("notification", onNotification);
    try {
      await client.query(`LISTEN ${PG_CHANNEL}`);
    } catch (err) {
      client.release(true);
      throw err;
    }
    listener = client;
  };
  const reconnect = (delay: number) => {
    const timer = setTimeout(() => {
      if (closed) return;
      listen().then(
        () => [...(handlers.get(CLUSTER_RESYNC) ?? [])].forEach((h) => h(undefined)),
        () => reconnect(Math.min(delay * 2, 30_000)),
      );
    }, delay);
    timer.unref?.();
  };

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
    await listen();
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
    // owner waiting for a free one, and the server hung. A lock is now a lease in the kv table:
    // no connection is held, the lease is renewed while `fn` runs, and a
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
        // https://github.com/k18k/matrix-nodejs-homeserver/issues/32: waiters only polled (backoff up
        // to 200 ms), so a lock handed to another node sat free for half the backoff on average.
        // Releasing now notifies, and a waiter retries at once; polling stays as the fallback for a
        // lost notification.
        for (let delay = 5; !(await acquire()); delay = Math.min(delay * 2, 200)) await releasedOrAfter(lockKey, delay);
        // https://github.com/k18k/matrix-nodejs-homeserver/issues/57: failed renewals were ignored, so an owner
        // whose lease had expired (database unreachable, event loop stalled) or been taken over by another node
        // carried on as if it still held the lock. The lease now counts as lost when a renewal finds it taken, or
        // when no renewal succeeded for a whole TTL; transactions under a lost lease then refuse to start or
        // commit (`assertLeases` in Homeserver.transaction), so a stale owner's writes roll back.
        // shortcut: writes outside a transaction are not fenced, and the check runs just before the commit, not
        // in it; a fencing token in the protected tables would close that if it ever matters.
        let lost: Error | null = null;
        let renewedAt = Date.now();
        const renew = setInterval(() => {
          const sentAt = Date.now();
          void pool.query(`UPDATE ${kv} SET expires_at = $3 WHERE key = $1 AND value = $2`, [lockKey, token, sentAt + LOCK_TTL_MS]).then(
            (res) => {
              if ((res.rowCount ?? 0) > 0) renewedAt = sentAt;
              else lost ??= new Error(`Cluster lock ${key} was lost: another instance took over its lease`);
            },
            () => {},
          );
        }, LOCK_TTL_MS / 3);
        const check = () => {
          if (!lost && Date.now() - renewedAt >= LOCK_TTL_MS)
            lost = new Error(`Cluster lock ${key} was lost: its lease could not be renewed`);
          if (lost) throw lost;
        };
        try {
          return await underLease(check, fn);
        } finally {
          clearInterval(renew);
          await pool
            .query(
              `WITH released AS (DELETE FROM ${kv} WHERE key = $1 AND value = $2 RETURNING key) SELECT pg_notify($3, $4) FROM released`,
              [lockKey, token, PG_CHANNEL, JSON.stringify({ channel: RELEASED, message: lockKey })],
            )
            .catch(() => {});
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
      closed = true;
      if (cleanup) clearInterval(cleanup);
      const l = listener;
      listener = null;
      if (l) {
        await l.query(`UNLISTEN ${PG_CHANNEL}`).catch(() => {});
        l.release();
      }
    },
  };
}
