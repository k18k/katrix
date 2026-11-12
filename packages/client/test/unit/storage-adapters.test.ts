import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { indexedDbStorage } from "../../src/adapters/indexeddb.ts";
import { sqliteStorage, type SqlExecutor } from "../../src/adapters/sqlite.ts";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { MemoryStorage } from "../../src/storage/memory.ts";
import { nodeSqlite } from "../env/sqlite.ts";

// Every StorageAdapter behaves the same: the memory one, SQLite (node:sqlite) and IndexedDB
// (fake-indexeddb, an implementation tested against the W3C's IndexedDB test suite).

const adapters: Array<[string, () => StorageAdapter]> = [
  ["memory", () => new MemoryStorage()],
  ["sqlite", () => sqliteStorage(nodeSqlite(":memory:"))],
  [
    "indexeddb",
    () => indexedDbStorage({ name: `t${Math.random()}`, indexedDB: new IDBFactory() as never, IDBKeyRange: IDBKeyRange as never }),
  ],
];

for (const [name, make] of adapters) {
  test(`${name}: get, list by prefix in key order, atomic batches`, async () => {
    const s = make();
    assert.equal(await s.get("rooms", "!a"), undefined);
    await s.write([
      { type: "put", store: "rooms", key: "!b|2", value: "B2" },
      { type: "put", store: "rooms", key: "!a|1", value: "A1" },
      { type: "put", store: "rooms", key: "!b|1", value: "B1" },
      { type: "put", store: "sync", key: "token", value: "s1" },
      { type: "put", store: "rooms", key: "ünïcode|é", value: "u" },
    ]);
    assert.equal(await s.get("rooms", "!a|1"), "A1");
    assert.deepEqual(await s.list("rooms", "!b|"), [
      ["!b|1", "B1"],
      ["!b|2", "B2"],
    ]);
    assert.deepEqual(await s.list("rooms", "ünï"), [["ünïcode|é", "u"]]);
    assert.equal((await s.list("rooms", "")).length, 4);
    await s.write([
      { type: "delete", store: "rooms", key: "!b|1" },
      { type: "put", store: "rooms", key: "!b|2", value: "B2'" },
      { type: "delete", store: "rooms", key: "missing" },
    ]);
    assert.deepEqual(await s.list("rooms", "!b"), [["!b|2", "B2'"]]);
    assert.deepEqual(await s.list("sync", ""), [["token", "s1"]], "stores are separate");
    await s.close?.();
  });
}

test("sqlite: a failing batch leaves nothing behind; data survives reopening", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "katrix-")), "db.sqlite");
  const exec = nodeSqlite(path);
  let fail = false;
  const flaky: SqlExecutor = {
    run: (sql, params) => {
      if (fail && sql.startsWith("DELETE")) throw new Error("disk full");
      return exec.run(sql, params);
    },
    all: exec.all,
  };
  const s = sqliteStorage(flaky);
  await s.write([{ type: "put", store: "account", key: "account", value: "v1" }]);
  fail = true;
  await assert.rejects(
    s.write([
      { type: "put", store: "account", key: "account", value: "v2" },
      { type: "delete", store: "account", key: "other" },
    ]),
    /disk full/,
  );
  assert.equal(await s.get("account", "account"), "v1", "rolled back");
  exec.db.close();
  const again = sqliteStorage(nodeSqlite(path));
  assert.equal(await again.get("account", "account"), "v1");
});
