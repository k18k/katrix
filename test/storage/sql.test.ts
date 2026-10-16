import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { sqliteAdapter } from "#storage/sql.ts";
import type { Schema } from "#storage/types.ts";

const schema: Schema = {
  items: {
    fields: { owner: { type: "string" }, id: { type: "number" }, label: { type: "string", required: false }, tags: { type: "json" } },
    primaryKey: ["owner", "id"],
    indexes: [["id"]],
  },
};

async function db() {
  const adapter = sqliteAdapter(new DatabaseSync(":memory:"));
  await adapter.migrate!(schema);
  return adapter;
}

// https://github.com/k18k/matrix-nodejs-homeserver/issues/39
test("upsertMany writes, updates and de-duplicates rows", async () => {
  const a = await db();
  await a.upsert("items", { owner: "a", id: 1, label: "old", tags: [] });
  await a.upsertMany!("items", [
    { owner: "a", id: 1, label: "new", tags: ["x"] },
    { owner: "a", id: 2, label: "first", tags: [] },
    // Same key twice in one call: the last one wins.
    { owner: "a", id: 2, label: "second", tags: [] },
    // Another set of columns (no label) goes in its own statement.
    { owner: "b", id: 1, tags: { k: 1 } },
  ]);
  const rows = await a.findMany("items", { sortBy: { field: "id", direction: "asc" } });
  const byKey = Object.fromEntries(rows.map((r) => [`${r.owner}/${r.id}`, r]));
  assert.equal(rows.length, 3);
  assert.deepEqual(byKey["a/1"], { owner: "a", id: 1, label: "new", tags: ["x"] });
  assert.equal(byKey["a/2"].label, "second");
  assert.deepEqual(byKey["b/1"].tags, { k: 1 });
});

test("upsertMany splits rows over several statements", async () => {
  const a = await db();
  const rows = Array.from({ length: 3000 }, (_, i) => ({ owner: "o", id: i, label: `l${i}`, tags: [i] }));
  await a.upsertMany!("items", rows);
  const read = await a.findMany("items", { fields: ["id"] });
  assert.equal(read.length, 3000);
});

// https://github.com/k18k/matrix-nodejs-homeserver/issues/40
test("in-lists of any length read the same rows", async () => {
  const a = await db();
  await a.upsertMany!(
    "items",
    Array.from({ length: 20 }, (_, i) => ({ owner: "o", id: i, tags: [] })),
  );
  for (const ids of [[], [3], [1, 2, 3], Array.from({ length: 15 }, (_, i) => i)]) {
    const rows = await a.findMany("items", { where: [{ field: "id", operator: "in", value: ids }], limit: 10 });
    assert.equal(rows.length, Math.min(ids.length, 10));
  }
});
