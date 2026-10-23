import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { localCluster, memoryAdapter, sqliteAdapter, type DatabaseAdapter } from "#index.ts";
import { testServer } from "../helpers.ts";

// Deterministic reliability checks (#63): what must hold under concurrency, restarts and failing
// writes. Longer soak and failure-injection runs are local (README, "Load testing").

type Server = Awaited<ReturnType<typeof testServer>>;

const send = (t: Server, token: string, room: string, body: string, txn: string) =>
  t.call("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${txn}`, {
    token,
    body: { msgtype: "m.text", body },
  });

const FILTER = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 1000 } } }));

/** Incremental /sync from `since` until `done` says so (or a deadline); returns the message bodies seen, in order. */
async function syncBodies(t: Server, token: string, room: string, since: string | null, done: (bodies: string[]) => boolean) {
  const bodies: string[] = [];
  let next = since;
  const deadline = Date.now() + 10_000;
  do {
    // A large timeline limit, so no response is cut short (limited) and every event must arrive.
    const res = await t.call("GET", `/_matrix/client/v3/sync?timeout=100&filter=${FILTER}${next ? `&since=${next}` : ""}`, { token });
    assert.equal(res.status, 200, res.text);
    assert.notEqual(res.json.rooms?.join?.[room]?.timeline?.limited, true, "timeline was limited");
    for (const ev of res.json.rooms?.join?.[room]?.timeline?.events ?? []) if (ev.type === "m.room.message") bodies.push(ev.content.body);
    next = res.json.next_batch;
  } while (!done(bodies) && Date.now() < deadline);
  return { bodies, next };
}

test("two nodes sending at once: /sync delivers every message exactly once, each sender in order", async () => {
  const shared = { databaseAdapter: memoryAdapter(), cluster: localCluster(), rateLimits: false as const };
  const a = await testServer(shared);
  const b = await testServer(shared);
  try {
    const alice = await a.user("alice");
    const bob = await a.user("bob");
    const carol = await a.user("carol");
    const room = (await a.call("POST", "/_matrix/client/v3/createRoom", { token: alice, body: { preset: "public_chat" } })).json.room_id;
    for (const token of [bob, carol]) await a.call("POST", `/_matrix/client/v3/join/${encodeURIComponent(room)}`, { token, body: {} });
    const { next: since } = await syncBodies(b, carol, room, null, () => true);

    const N = 30;
    const sending = Promise.all([
      (async () => {
        for (let i = 0; i < N; i++) assert.equal((await send(a, alice, room, `a${i}`, `a${i}`)).status, 200);
      })(),
      (async () => {
        for (let i = 0; i < N; i++) assert.equal((await send(b, bob, room, `b${i}`, `b${i}`)).status, 200);
      })(),
    ]);
    // Carol reads on node B while both nodes write.
    const reading = syncBodies(b, carol, room, since, (bodies) => bodies.length >= 2 * N);
    await sending;
    const { bodies } = await reading;

    assert.equal(bodies.length, 2 * N, `got ${bodies.length}: ${bodies.join(" ")}`);
    assert.equal(new Set(bodies).size, 2 * N, "no duplicates");
    for (const who of ["a", "b"]) {
      const own = bodies.filter((x) => x.startsWith(who)).map((x) => Number(x.slice(1)));
      assert.deepEqual(
        own,
        own.toSorted((x, y) => x - y),
        `${who}'s messages in order`,
      );
    }
  } finally {
    await a.close();
    await b.close();
  }
});

test("a sync token from before a restart still works after it", async () => {
  const dir = mkdtempSync(`${tmpdir()}/reliability-`);
  const db = new DatabaseSync(`${dir}/homeserver.db`);
  try {
    const start = () => testServer({ databaseAdapter: sqliteAdapter(db) });
    const first = await start();
    const alice = await first.user("alice");
    const room = (await first.call("POST", "/_matrix/client/v3/createRoom", { token: alice, body: {} })).json.room_id;
    await send(first, alice, room, "before", "t1");
    const { next: since } = await syncBodies(first, alice, room, null, () => true);
    await first.close();

    const second = await start();
    try {
      await send(second, alice, room, "after", "t2");
      const { bodies } = await syncBodies(second, alice, room, since, (seen) => seen.length >= 1);
      assert.deepEqual(bodies, ["after"]);
    } finally {
      await second.close();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A database whose next event write fails, once `fail()` is called: as if the database went away mid-write. */
function failingDatabase(inner: DatabaseAdapter) {
  let armed = false;
  const wrap = (db: DatabaseAdapter): DatabaseAdapter =>
    new Proxy(db, {
      get(target, prop) {
        if (prop === "create")
          return async (model: string, data: Record<string, unknown>) => {
            if (armed && model === "events") {
              armed = false;
              throw new Error("injected database failure");
            }
            return target.create(model, data);
          };
        if (prop === "transaction" && target.transaction)
          return <T>(fn: (tx: DatabaseAdapter) => Promise<T>) => target.transaction!((tx) => fn(wrap(tx)));
        const value = (target as any)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return { db: wrap(inner), fail: () => (armed = true) };
}

test("a write that fails halfway leaves no trace and does not stall /sync", async () => {
  const faulty = failingDatabase(memoryAdapter());
  const t = await testServer({ databaseAdapter: faulty.db });
  try {
    const alice = await t.user("alice");
    const room = (await t.call("POST", "/_matrix/client/v3/createRoom", { token: alice, body: {} })).json.room_id;
    const { next: since } = await syncBodies(t, alice, room, null, () => true);

    faulty.fail();
    assert.equal((await send(t, alice, room, "lost", "t1")).status, 500);
    assert.equal((await send(t, alice, room, "kept", "t2")).status, 200);

    // The failed event is nowhere, and the stream moved on past it.
    const { bodies } = await syncBodies(t, alice, room, since, (seen) => seen.length >= 1);
    assert.deepEqual(bodies, ["kept"]);
    const history = await t.call("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=50`, { token: alice });
    assert.deepEqual(
      history.json.chunk.filter((e: any) => e.type === "m.room.message").map((e: any) => e.content.body),
      ["kept"],
    );
  } finally {
    await t.close();
  }
});
