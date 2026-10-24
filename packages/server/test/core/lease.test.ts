import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { postgresCluster, type PgClusterPoolLike } from "#index.ts";
import { assertLeases } from "#core/cluster.ts";

// A leased Postgres lock whose lease is lost stops its owner's transactions (#57).

/** Just enough of `pg` for the lock: the kv table as a map; `down` makes every query fail. */
function fakePool() {
  const kv = new Map<string, { value: string; expires: number }>();
  const state = { kv, down: false };
  const query = async (text: string, v: any[] = []) => {
    if (state.down) throw new Error("connection refused");
    if (text.startsWith("INSERT") && text.includes("ON CONFLICT (key) DO UPDATE")) {
      const row = kv.get(v[0]);
      if (row && row.expires > v[3]) return { rows: [], rowCount: 0 };
      kv.set(v[0], { value: v[1], expires: v[2] });
      return { rows: [{ key: v[0] }], rowCount: 1 };
    }
    if (text.startsWith("UPDATE")) {
      const row = kv.get(v[0]);
      if (!row || row.value !== v[1]) return { rows: [], rowCount: 0 };
      row.expires = v[2];
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("WITH released")) {
      if (kv.get(v[0])?.value === v[1]) kv.delete(v[0]);
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool: PgClusterPoolLike = { query, connect: async () => ({ query, release() {}, on() {} }) };
  return { pool, state };
}

/** Hold the lock while `during` runs, then report whether the lease still held. */
async function holdWhile(during: (state: ReturnType<typeof fakePool>["state"]) => Promise<void>) {
  const { pool, state } = fakePool();
  const cluster = postgresCluster(pool);
  return cluster.lock("room:!r", async () => {
    await during(state);
    try {
      assertLeases();
      return "held";
    } catch (err) {
      return (err as Error).message;
    }
  });
}

/** Advance mocked time in renewal-sized steps, letting each renewal's query settle. */
async function elapse(ms: number) {
  for (let t = 0; t < ms; t += 5_000) {
    mock.timers.tick(5_000);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a lease kept renewed holds", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  try {
    assert.equal(await holdWhile(() => elapse(120_000)), "held");
  } finally {
    mock.timers.reset();
  }
});

test("a lease taken over by another instance is lost", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  try {
    const result = await holdWhile(async (state) => {
      state.kv.get("lock:room:!r")!.value = "someone else";
      await elapse(15_000);
    });
    assert.match(result, /another instance took over/);
  } finally {
    mock.timers.reset();
  }
});

test("a lease that cannot be renewed for a whole TTL is lost", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  try {
    const result = await holdWhile(async (state) => {
      state.down = true;
      await elapse(30_000);
      state.down = false;
    });
    assert.match(result, /could not be renewed/);
  } finally {
    mock.timers.reset();
  }
});

test("outside a lock, and with the default cluster, nothing is fenced", () => {
  assert.doesNotThrow(() => assertLeases());
});
