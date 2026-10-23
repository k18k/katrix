import assert from "node:assert/strict";
import type { DatabaseAdapter, Row, Schema, WhereClause } from "#storage/types.ts";

/**
 * Checks that a `DatabaseAdapter` keeps the guarantees the homeserver relies on (see the
 * interface's documentation). Each check gets a fresh adapter on which `CONFORMANCE_SCHEMA` was
 * migrated, and throws (an `AssertionError`) when the adapter falls short. They do not depend on a
 * test framework:
 *
 *   for (const check of adapterConformance) test(check.name, async () => check.run(await freshAdapter()));
 *
 * https://github.com/k18k/matrix-nodejs-homeserver/issues/58: the contract was implicit, so a custom
 * adapter could miss a guarantee (an atomic conditional delete, a rollback) without anything noticing.
 */
export interface ConformanceCheck {
  name: string;
  run(adapter: DatabaseAdapter): Promise<void>;
}

/** The tables the checks use. Migrate them before each check (`adapter.migrate(CONFORMANCE_SCHEMA)`). */
export const CONFORMANCE_SCHEMA: Schema = {
  conformance_items: {
    fields: {
      owner: { type: "string" },
      id: { type: "number" },
      label: { type: "string", required: false },
      flag: { type: "boolean" },
      data: { type: "json" },
    },
    primaryKey: ["owner", "id"],
    indexes: [["id"]],
  },
};

const T = "conformance_items";
const item = (owner: string, id: number, extra: Record<string, unknown> = {}) => ({
  owner,
  id,
  label: null,
  flag: false,
  data: {},
  ...extra,
});
const ids = (rows: Row[]) => rows.map((r) => r.id as number).sort((a, b) => a - b);

async function seed(db: DatabaseAdapter, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) await db.create(T, item("a", i, { label: `item ${i}`, flag: i % 2 === 0 }));
}

export const adapterConformance: ConformanceCheck[] = [
  {
    name: "migrate is idempotent and keeps existing rows",
    async run(db) {
      await db.create(T, item("a", 1));
      await db.migrate?.(CONFORMANCE_SCHEMA);
      await db.migrate?.(CONFORMANCE_SCHEMA);
      assert.ok(await db.findOne(T, [{ field: "id", value: 1 }]));
    },
  },
  {
    name: "every field type round-trips",
    async run(db) {
      const row = {
        owner: "ünïcode ✓",
        id: Number.MAX_SAFE_INTEGER,
        label: null,
        flag: true,
        data: { a: [1, "two", null], b: { c: true } },
      };
      await db.create(T, row);
      assert.deepEqual(await db.findOne(T, [{ field: "owner", value: row.owner }]), row);
      await db.create(T, item("b", 0, { data: [] }));
      assert.deepEqual((await db.findOne(T, [{ field: "owner", value: "b" }]))?.data, []);
    },
  },
  {
    name: "create refuses an existing primary key",
    async run(db) {
      await db.create(T, item("a", 1));
      await assert.rejects(db.create(T, item("a", 1, { label: "again" })));
      assert.equal((await db.findOne(T, [{ field: "id", value: 1 }]))?.label, null);
    },
  },
  {
    name: "upsert inserts, then replaces by primary key",
    async run(db) {
      await db.upsert(T, item("a", 1, { label: "first" }));
      await db.upsert(T, item("a", 1, { label: "second" }));
      const rows = await db.findMany(T);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].label, "second");
    },
  },
  {
    name: "update and delete report how many rows they changed",
    async run(db) {
      await seed(db, 4);
      assert.equal(await db.update(T, [{ field: "flag", value: true }], { label: "even" }), 2);
      assert.equal(await db.update(T, [{ field: "id", value: 99 }], { label: "none" }), 0);
      assert.equal(await db.delete(T, [{ field: "label", value: "even" }]), 2);
      assert.equal(await db.delete(T, [{ field: "label", value: "even" }]), 0);
      assert.deepEqual(ids(await db.findMany(T)), [1, 3]);
    },
  },
  {
    name: "where operators, combined with AND",
    async run(db) {
      await seed(db, 5);
      const where = async (w: WhereClause[]) => ids(await db.findMany(T, { where: w }));
      assert.deepEqual(await where([{ field: "id", operator: "ne", value: 3 }]), [1, 2, 4, 5]);
      assert.deepEqual(await where([{ field: "id", operator: "lt", value: 3 }]), [1, 2]);
      assert.deepEqual(await where([{ field: "id", operator: "lte", value: 3 }]), [1, 2, 3]);
      assert.deepEqual(await where([{ field: "id", operator: "gt", value: 3 }]), [4, 5]);
      assert.deepEqual(await where([{ field: "id", operator: "gte", value: 3 }]), [3, 4, 5]);
      assert.deepEqual(await where([{ field: "id", operator: "in", value: [1, 4, 9] }]), [1, 4]);
      assert.deepEqual(await where([{ field: "id", operator: "in", value: [] }]), []);
      assert.deepEqual(
        await where([
          { field: "flag", value: true },
          { field: "id", operator: "gt", value: 2 },
        ]),
        [4],
      );
      assert.deepEqual(await where([{ field: "label", value: null }]), []);
    },
  },
  {
    name: "findMany sorts, limits, and may return only some fields",
    async run(db) {
      await seed(db, 5);
      const desc = await db.findMany(T, { sortBy: { field: "id", direction: "desc" }, limit: 2 });
      assert.deepEqual(
        desc.map((r) => r.id),
        [5, 4],
      );
      const asc = await db.findMany(T, { sortBy: { field: "id", direction: "asc" }, limit: 2, fields: ["id"] });
      assert.deepEqual(
        asc.map((r) => r.id),
        [1, 2],
      );
    },
  },
  {
    name: "max is null without rows, the largest value otherwise",
    async run(db) {
      assert.equal(await db.max(T, "id"), null);
      await seed(db, 3);
      assert.equal(await db.max(T, "id"), 3);
    },
  },
  {
    name: "a transaction commits all of its writes, and sees them before it commits",
    async run(db) {
      if (!db.transaction) return;
      const result = await db.transaction(async (tx) => {
        await tx.create(T, item("a", 1));
        await tx.update(T, [{ field: "id", value: 1 }], { label: "inside" });
        return (await tx.findOne(T, [{ field: "id", value: 1 }]))?.label;
      });
      assert.equal(result, "inside");
      assert.equal((await db.findOne(T, [{ field: "id", value: 1 }]))?.label, "inside");
    },
  },
  {
    name: "a transaction that throws applies none of its writes, and the error reaches the caller",
    async run(db) {
      if (!db.transaction) return;
      await db.create(T, item("a", 1, { label: "before" }));
      const failure = new Error("abort");
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.update(T, [{ field: "id", value: 1 }], { label: "changed" });
          await tx.create(T, item("a", 2));
          await tx.delete(T, [{ field: "id", value: 1 }]);
          throw failure;
        }),
        (err) => err === failure,
      );
      assert.deepEqual(ids(await db.findMany(T)), [1]);
      assert.equal((await db.findOne(T, [{ field: "id", value: 1 }]))?.label, "before");
    },
  },
  {
    // #95: on SQLite such a write ran inside the transaction and was undone by its rollback.
    name: "a write outside a transaction is not undone by that transaction's rollback, even when both start at once",
    async run(db) {
      if (!db.transaction) return;
      const [outside, tx] = await Promise.allSettled([
        db.create(T, item("a", 1)),
        db.transaction(async () => {
          await Promise.resolve();
          throw new Error("rollback");
        }),
      ]);
      assert.equal(outside.status, "fulfilled");
      assert.equal(tx.status, "rejected");
      assert.deepEqual(ids(await db.findMany(T)), [1]);
    },
  },
  {
    name: "of concurrent deletes of one row, exactly one reports it (single-use tokens rely on this)",
    async run(db) {
      await db.create(T, item("a", 1));
      const counts = await Promise.all(Array.from({ length: 8 }, () => db.delete(T, [{ field: "id", value: 1 }])));
      assert.deepEqual(
        counts.sort((a, b) => b - a),
        [1, 0, 0, 0, 0, 0, 0, 0],
      );
    },
  },
  {
    name: "of concurrent creates of one primary key, exactly one succeeds",
    async run(db) {
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => db.create(T, item("a", 1, { label: `${i}` }))));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal((await db.findMany(T)).length, 1);
    },
  },
  {
    name: "optional batch operations behave like their one-by-one counterparts",
    async run(db) {
      await seed(db, 3);
      if (db.findManyBatch) {
        const queries = [
          { model: T, opts: { where: [{ field: "id", value: 2 }] } },
          { model: T, opts: { where: [{ field: "id", operator: "gt" as const, value: 1 }] } },
        ];
        const batched = await db.findManyBatch(queries);
        assert.equal(batched.length, 2);
        for (let i = 0; i < queries.length; i++) assert.deepEqual(ids(batched[i]), ids(await db.findMany(T, queries[i].opts)));
      }
      if (db.upsertMany) {
        await db.upsertMany(T, [item("a", 1, { label: "x" }), item("a", 4), item("a", 4, { label: "last" })]);
        assert.equal((await db.findOne(T, [{ field: "id", value: 1 }]))?.label, "x");
        assert.equal((await db.findOne(T, [{ field: "id", value: 4 }]))?.label, "last");
      }
    },
  },
];
