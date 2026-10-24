import { test } from "node:test";
import assert from "node:assert/strict";
import type { StorageAdapter, WriteOp } from "../../src/storage/adapter.ts";
import { MemoryStorage } from "../../src/storage/memory.ts";
import { Store } from "../../src/storage/store.ts";

/** A memory adapter whose next write can be made to fail, as a full disk or a closed database would. */
class FlakyStorage extends MemoryStorage {
  failNext = false;
  writes: WriteOp[][] = [];
  override async write(batch: readonly WriteOp[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("disk full");
    }
    this.writes.push([...batch]);
    return super.write(batch);
  }
}

test("a unit of work reads its own writes and commits them in one batch", async () => {
  const adapter = new FlakyStorage();
  const store = new Store(adapter);
  await store.transaction(async (tx) => {
    tx.put("sync", "token", "s1");
    tx.put("rooms", "!a", { n: 1 });
    tx.put("rooms", "!b", { n: 2 });
    tx.delete("rooms", "!b");
    tx.put("rooms", "!a", { n: 3 });
    assert.equal(await tx.get("sync", "token"), "s1");
    assert.deepEqual(await tx.list("rooms"), [["!a", { n: 3 }]]);
    assert.equal(await store.get("sync", "token"), undefined, "not visible outside before commit");
  });
  assert.equal(adapter.writes.length, 1, "one atomic batch");
  assert.deepEqual(await store.list("rooms"), [["!a", { n: 3 }]]);
  assert.equal(await store.get("sync", "token"), "s1");
});

test("nothing is written when the task throws or the adapter's write fails", async () => {
  const adapter = new FlakyStorage();
  const store = new Store(adapter);
  await store.transaction(async (tx) => tx.put("sync", "token", "old"));
  await assert.rejects(
    store.transaction(async (tx) => {
      tx.put("sync", "token", "new");
      tx.put("account", "account", { pickle: "x" });
      throw new Error("decryption blew up");
    }),
    /blew up/,
  );
  adapter.failNext = true;
  let committed = false;
  await assert.rejects(
    store.transaction(async (tx) => {
      tx.put("sync", "token", "new");
      tx.onCommit(() => (committed = true));
    }),
    /disk full/,
  );
  assert.equal(committed, false, "commit hooks run only after a durable write");
  assert.equal(await store.get("sync", "token"), "old");
  assert.equal(await store.get("account", "account"), undefined);
});

test("units of work run one at a time: no lost updates", async () => {
  const store = new Store(new MemoryStorage());
  await store.transaction(async (tx) => tx.put("client", "n", 0));
  await Promise.all(
    Array.from({ length: 20 }, () =>
      store.transaction(async (tx) => {
        const n = (await tx.get<number>("client", "n"))!;
        await new Promise((r) => setTimeout(r, Math.random() * 3));
        tx.put("client", "n", n + 1);
      }),
    ),
  );
  assert.equal(await store.get("client", "n"), 20);
});

test("list returns entries by prefix in key order, merged with pending writes", async () => {
  const adapter: StorageAdapter = new MemoryStorage();
  const store = new Store(adapter);
  await store.transaction(async (tx) => {
    for (const k of ["b|2", "a|1", "b|1", "c|1"]) tx.put("olm_sessions", k, k);
  });
  await store.transaction(async (tx) => {
    tx.put("olm_sessions", "b|0", "b|0");
    tx.delete("olm_sessions", "b|2");
    assert.deepEqual(
      (await tx.list("olm_sessions", "b|")).map(([k]) => k),
      ["b|0", "b|1"],
    );
  });
});

test("writing after commit is a bug and throws", async () => {
  const store = new Store(new MemoryStorage());
  let leaked: { put(s: "client", k: string, v: unknown): void } | undefined;
  await store.transaction(async (tx) => {
    leaked = tx;
  });
  assert.throws(() => leaked!.put("client", "k", 1), /after the unit of work/);
});
