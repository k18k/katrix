import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { memoryAdapter, sqliteAdapter } from "#index.ts";
import { testServer } from "../helpers.ts";

const BACKENDS = {
  memory: () => ({ databaseAdapter: memoryAdapter(), cleanup: () => {} }),
  sqlite: () => {
    const dir = mkdtempSync(`${tmpdir()}/auth-`);
    const db = new DatabaseSync(`${dir}/homeserver.db`);
    return {
      databaseAdapter: sqliteAdapter(db),
      cleanup: () => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
};

for (const [backend, make] of Object.entries(BACKENDS)) {
  test(`a login token redeemed by concurrent requests logs in only one of them (#56, ${backend})`, async () => {
    const { databaseAdapter, cleanup } = make();
    const t = await testServer({ databaseAdapter });
    try {
      await t.hs.admin.createUser("alice", { password: "password" });
      const token = await t.hs.auth.createLoginToken("@alice:localhost");
      const results = await Promise.all(
        // Five: the login rate limit's burst.
        Array.from({ length: 5 }, () => t.call("POST", "/_matrix/client/v3/login", { body: { type: "m.login.token", token } })),
      );
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 403, 403, 403, 403]);
    } finally {
      await t.close();
      cleanup();
    }
  });
}
