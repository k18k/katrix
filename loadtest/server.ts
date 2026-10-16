// Homeserver for load tests (see loadtest/README.md). One node, or one of several behind the load
// balancer: with DATABASE_URL every node shares Postgres and coordinates through it, as in
// examples/multi-node.ts. Without it, a single node runs on SQLite in DATA_DIR.
//
// Every 10 s it prints what decides capacity: requests per second and their errors, memory, and
// event-loop delay (when that grows, the process is CPU-bound and requests queue).
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { hostname } from "node:os";
import {
  createHomeserver,
  getNodeHandler,
  memoryMedia,
  postgresAdapter,
  postgresCluster,
  sqliteAdapter,
  type DatabaseAdapter,
  type ClusterAdapter,
} from "../src/index.ts";

let databaseAdapter: DatabaseAdapter;
// Postgres pools, sampled for queued queries (see the stats below).
let pools: Record<string, { waitingCount: number; totalCount: number; idleCount: number }> = {};
let cluster: ClusterAdapter | undefined;
if (process.env.DATABASE_URL) {
  // Optional dependency of the library, installed in the load-test image.
  const pgModule: string = "pg";
  const { default: pg } = await import(pgModule);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL ?? 20) });
  databaseAdapter = postgresAdapter(pool);
  // Coordination (locks, stream positions) gets connections of its own: sharing the data pool,
  // its short queries waited behind every /sync read, and lock holders with them.
  pools = { data: pool };
  // CLUSTER=0: one process on Postgres without a cluster adapter (the default, in-process one).
  if (process.env.CLUSTER !== "0") {
    const clusterPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.CLUSTER_POOL ?? 5) });
    cluster = postgresCluster(clusterPool);
    pools.cluster = clusterPool;
  }
  if (process.env.LOCK_STATS && cluster) cluster = timedLocks(cluster);
} else {
  const db = new DatabaseSync(`${process.env.DATA_DIR ?? "."}/loadtest.db`);
  databaseAdapter = sqliteAdapter(process.env.QUERY_STATS ? timed(db) : db);
}

// QUERY_STATS=1 (SQLite only): time every statement and print the ones that took longest in each
// interval. node:sqlite runs on the main thread, so this is time the event loop was blocked.
const queryStats = new Map<string, { n: number; ms: number }>();
function timed(db: DatabaseSync): DatabaseSync {
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const stmt = prepare(sql);
    const key = sql.replace(/\s+/g, " ").slice(0, 160);
    for (const method of ["all", "get", "run"] as const) {
      const original = (stmt as any)[method].bind(stmt);
      (stmt as any)[method] = (...args: unknown[]) => {
        const start = performance.now();
        try {
          return original(...args);
        } finally {
          const s = queryStats.get(key) ?? { n: 0, ms: 0 };
          s.n++;
          s.ms += performance.now() - start;
          queryStats.set(key, s);
        }
      };
    }
    return stmt;
  }) as typeof db.prepare;
  return db;
}

// LOCK_STATS=1 (with a cluster adapter): how long locks were waited for and held, by key prefix
// (room:, pushrules:, ...). Long holds on a busy key are where requests queue.
const lockStats = new Map<string, { n: number; waitMs: number; holdMs: number; maxWaitMs: number }>();
function timedLocks(c: ClusterAdapter): ClusterAdapter {
  const lock = c.lock.bind(c);
  c.lock = (key, fn) => {
    const asked = performance.now();
    const prefix = key.split(":")[0];
    return lock(key, async () => {
      const got = performance.now();
      try {
        return await fn();
      } finally {
        const st = lockStats.get(prefix) ?? { n: 0, waitMs: 0, holdMs: 0, maxWaitMs: 0 };
        st.n++;
        st.waitMs += got - asked;
        st.holdMs += performance.now() - got;
        st.maxWaitMs = Math.max(st.maxWaitMs, got - asked);
        lockStats.set(prefix, st);
      }
    });
  };
  return c;
}

const homeserver = createHomeserver({
  homeserver: process.env.SERVER_NAME ?? "loadtest.local",
  databaseAdapter,
  cluster,
  mediaAdapter: memoryMedia(),
  userAuthAdapter: { registrationEnabled: true },
  // The load comes from a few IP addresses, which rate limits would throttle; measure the server instead.
  rateLimits: false,
  ...(process.env.MAX_CONCURRENT_SYNCS ? { maxConcurrentSyncs: Number(process.env.MAX_CONCURRENT_SYNCS) } : {}),
  logger: { debug() {}, info: console.log, warn: console.warn, error: console.error },
});

// With LOCK_STATS also: how long stream positions took to allocate and to complete.
const streamStats = { n: 0, allocMs: 0, doneMs: 0, maxAllocMs: 0, maxDoneMs: 0 };
if (process.env.LOCK_STATS) {
  const streams = homeserver.streams;
  const allocate = streams.allocate.bind(streams);
  streams.allocate = async () => {
    const t0 = performance.now();
    const lease = await allocate();
    const a = performance.now() - t0;
    streamStats.n++;
    streamStats.allocMs += a;
    streamStats.maxAllocMs = Math.max(streamStats.maxAllocMs, a);
    const done = lease.done;
    lease.done = async () => {
      const t1 = performance.now();
      await done();
      const d = performance.now() - t1;
      streamStats.doneMs += d;
      streamStats.maxDoneMs = Math.max(streamStats.maxDoneMs, d);
    };
    return lease;
  };
}

// Pool pressure: queries waiting for a connection, sampled every 100 ms.
const poolStats = new Map<string, { samples: number; waiting: number; maxWaiting: number; busy: number }>();
setInterval(() => {
  for (const [name, p] of Object.entries(pools)) {
    const st = poolStats.get(name) ?? { samples: 0, waiting: 0, maxWaiting: 0, busy: 0 };
    st.samples++;
    st.waiting += p.waitingCount;
    st.maxWaiting = Math.max(st.maxWaiting, p.waitingCount);
    st.busy += p.totalCount - p.idleCount;
    poolStats.set(name, st);
  }
}, 100).unref();

let requests = 0;
let errors = 0;
homeserver.on("request", (r: { status: number }) => {
  requests++;
  if (r.status >= 500) errors++;
});
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
const node = hostname();
setInterval(() => {
  const mem = process.memoryUsage();
  const ms = (ns: number) => (ns / 1e6).toFixed(1);
  console.log(
    `[${node}] ${(requests / 10).toFixed(0)} req/s, ${errors} 5xx, rss ${(mem.rss / 2 ** 20).toFixed(0)} MB, heap ${(mem.heapUsed / 2 ** 20).toFixed(0)} MB, ` +
      `loop delay p50 ${ms(loop.percentile(50))} ms p99 ${ms(loop.percentile(99))} ms max ${ms(loop.max)} ms`,
  );
  requests = errors = 0;
  loop.reset();
  for (const [prefix, st] of lockStats)
    console.log(
      `    lock ${prefix}: ${st.n}x, wait avg ${(st.waitMs / st.n).toFixed(0)} ms max ${st.maxWaitMs.toFixed(0)} ms, hold avg ${(st.holdMs / st.n).toFixed(0)} ms`,
    );
  lockStats.clear();
  for (const [name, st] of poolStats)
    console.log(
      `    pool ${name}: busy avg ${(st.busy / st.samples).toFixed(1)}, waiting avg ${(st.waiting / st.samples).toFixed(1)} max ${st.maxWaiting}`,
    );
  poolStats.clear();
  if (streamStats.n) {
    const st = streamStats;
    console.log(
      `    stream: ${st.n}x, allocate avg ${(st.allocMs / st.n).toFixed(0)} ms max ${st.maxAllocMs.toFixed(0)} ms, done avg ${(st.doneMs / st.n).toFixed(0)} ms max ${st.maxDoneMs.toFixed(0)} ms`,
    );
    Object.assign(st, { n: 0, allocMs: 0, doneMs: 0, maxAllocMs: 0, maxDoneMs: 0 });
  }
  if (queryStats.size) {
    for (const [sql, q] of [...queryStats].sort((x, y) => y[1].ms - x[1].ms).slice(0, 8))
      console.log(`    ${q.ms.toFixed(0).padStart(6)} ms ${String(q.n).padStart(7)}x  ${sql}`);
    queryStats.clear();
  }
}, 10_000).unref();

const server = createServer(getNodeHandler(homeserver));
// Long-polling /sync keeps many connections open: allow them, and keep idle ones for the load balancer.
server.maxConnections = Number(process.env.MAX_CONNECTIONS ?? 1_000_000);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(Number(process.env.PORT ?? 8008), () => console.log(`[${node}] load-test homeserver on :${process.env.PORT ?? 8008}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void homeserver.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
