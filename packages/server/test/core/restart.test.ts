import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { sqliteAdapter } from "#index.ts";
import { testServer } from "../helpers.ts";

test("after a restart, audit entries get new IDs (#70)", async () => {
  const dir = mkdtempSync(`${tmpdir()}/restart-`);
  const db = new DatabaseSync(`${dir}/homeserver.db`);
  try {
    const start = () => testServer({ databaseAdapter: sqliteAdapter(db), audit: { enabled: true } });
    const first = await start();
    await first.user("alice");
    await first.close();
    const second = await start();
    try {
      const errors: unknown[] = [];
      second.hs.logger.warn = (...args: unknown[]) => errors.push(args);
      second.hs.logger.error = (...args: unknown[]) => errors.push(args);
      await second.user("bob");
      const ids = (await second.hs.db.findMany("audit_log")).map((r) => r.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(ids.length >= 2, `audit entries: ${ids.length}`);
      assert.deepEqual(errors, []);
    } finally {
      await second.close();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
