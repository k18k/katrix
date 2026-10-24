import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ChangeLog, ChangeTracker, trackedReads } from "#core/changes.ts";
import { sqliteAdapter } from "#storage/sql.ts";
import { schema } from "#storage/schema.ts";

// https://github.com/k18k/katrix/issues/51

test("a change log answers 'unchanged' only when it knows", () => {
  const log = new ChangeLog(2, 10);
  assert.equal(log.changedAfter("a", 5), true, "below the floor nothing is known");
  assert.equal(log.changedAfter("a", 10), false);
  log.record("a", 12);
  assert.equal(log.changedAfter("a", 11), true);
  assert.equal(log.changedAfter("a", 12), false);
  log.record("b", 13);
  log.record("c", 14);
  // "a" was forgotten to stay within two keys: positions up to its change are unknown now.
  assert.equal(log.changedAfter("a", 11), true);
  assert.equal(log.changedAfter("zzz", 11), true);
  assert.equal(log.changedAfter("zzz", 12), false);
});

async function tracked() {
  const tracker = new ChangeTracker();
  const db = tracker.wrap(sqliteAdapter(new DatabaseSync(":memory:")));
  await db.migrate!(schema);
  tracker.start(0);
  return { tracker, db };
}

const membershipsOf = (userId: string) => ({ model: "memberships", opts: { where: [{ field: "user_id", value: userId }] } });

test("writes after the token are seen; none means no read", async () => {
  const { tracker, db } = await tracked();
  const read = (after: number) =>
    trackedReads(db, tracker, [
      {
        query: { model: "to_device", opts: { where: [{ field: "user_id", value: "@u:x" }] } },
        unlessChanged: { log: "toDevice", key: "@u:x|D", after },
      },
    ]);
  await db.create("to_device", { user_id: "@u:x", device_id: "D", stream: 5, sender: "@s:x", type: "t", content: {} });
  assert.equal((await read(4))[0].length, 1);
  // Known not to have changed after 5: answered without the database (an empty result).
  assert.deepEqual((await read(5))[0], []);
});

test("a cached value is dropped when its key is written", async () => {
  const { tracker, db } = await tracked();
  const read = async () =>
    (await trackedReads(db, tracker, [{ query: membershipsOf("@u:x"), cached: { name: "userMemberships", key: "@u:x" } }]))[0];
  assert.equal((await read()).length, 0);
  await db.upsert("memberships", { room_id: "!r:x", user_id: "@u:x", membership: "join", event_id: "$e", stream: 1, forgotten: false });
  assert.equal((await read()).length, 1);
  assert.ok(Object.isFrozen(await read()), "shared rows are frozen");
});

test("a value read while its key is written is not kept", async () => {
  const { tracker, db } = await tracked();
  const cache = tracker.values.userMemberships;
  // The read begins, a write to the key happens before it completes, then the read completes.
  const value = await cache.get("@u:x", async () => {
    const rows = await db.findMany("memberships", { where: [{ field: "user_id", value: "@u:x" }] });
    await db.upsert("memberships", { room_id: "!r:x", user_id: "@u:x", membership: "join", event_id: "$e", stream: 1, forgotten: false });
    return rows;
  });
  assert.equal(value.length, 0);
  assert.equal(cache.peek("@u:x"), undefined, "the stale read was not kept");
});

test("a value read before a transaction commits is not kept", async () => {
  const { tracker, db } = await tracked();
  const cache = tracker.values.userMemberships;
  let written!: () => void;
  const inTx = new Promise<void>((r) => (written = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const tx = db.transaction!(async (t) => {
    await t.upsert("memberships", { room_id: "!r:x", user_id: "@u:x", membership: "join", event_id: "$e", stream: 1, forgotten: false });
    written();
    await gate;
  });
  // After the write in the transaction, before it commits: the read still sees the old rows (on
  // a database with concurrent readers), and must not be kept once the transaction commits.
  await inTx;
  await cache.get("@u:x", async () => []);
  release();
  await tx;
  assert.equal(cache.peek("@u:x"), undefined);
});

test("a write without its key fields forgets every kept value", async () => {
  const { tracker, db } = await tracked();
  const cache = tracker.values.unreadCounts;
  await cache.get("@u:x|!r:x", async () => ({ room: { notification_count: 1, highlight_count: 0 }, threads: {} }));
  assert.notEqual(cache.peek("@u:x|!r:x"), undefined);
  await db.delete("notifications", [{ field: "ts", operator: "lt", value: 0 }]);
  assert.equal(cache.peek("@u:x|!r:x"), undefined);
});
