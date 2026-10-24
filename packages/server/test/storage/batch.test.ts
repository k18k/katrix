import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryAdapter } from "#storage/memory.ts";
import { coalesceReads } from "#storage/batch.ts";
import type { BatchQuery, DatabaseAdapter } from "#storage/types.ts";

/** A memory adapter with a findManyBatch that records its calls and fails on a "broken" model. */
async function counting() {
  const inner = memoryAdapter();
  await inner.migrate?.({ items: { fields: { id: { type: "number" }, label: { type: "string" } }, primaryKey: ["id"] } });
  for (let i = 0; i < 5; i++) await inner.create("items", { id: i, label: `l${i}` });
  const batches: number[] = [];
  const db: DatabaseAdapter = {
    ...inner,
    async findManyBatch(queries: BatchQuery[]) {
      batches.push(queries.length);
      if (queries.some((q) => q.model === "broken")) throw new Error("bad read");
      return Promise.all(queries.map((q) => inner.findMany(q.model, q.opts)));
    },
    async findMany(model, opts) {
      if (model === "broken") throw new Error("bad read");
      return inner.findMany(model, opts);
    },
  };
  return { db: coalesceReads(db), batches };
}

// https://github.com/k18k/katrix/issues/43
test("reads issued together go out as one batch, each with its own result", async () => {
  const { db, batches } = await counting();
  const [all, one, none] = await Promise.all([
    db.findMany("items", { sortBy: { field: "id", direction: "asc" } }),
    db.findOne("items", [{ field: "id", value: 3 }]),
    db.findOne("items", [{ field: "id", value: 99 }]),
  ]);
  assert.deepEqual(batches, [3]);
  assert.deepEqual(
    all.map((r) => r.id),
    [0, 1, 2, 3, 4],
  );
  assert.equal(one?.label, "l3");
  assert.equal(none, null);
  // A read on its own is not batched.
  await db.findOne("items", [{ field: "id", value: 1 }]);
  assert.deepEqual(batches, [3]);
});

test("a failing read fails alone", async () => {
  const { db } = await counting();
  const [good, bad] = await Promise.allSettled([db.findOne("items", [{ field: "id", value: 2 }]), db.findMany("broken")]);
  assert.equal(good.status === "fulfilled" && good.value?.label, "l2");
  assert.equal(bad.status, "rejected");
});
