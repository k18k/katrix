import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { localCluster, memoryAdapter, sqliteAdapter } from "#index.ts";
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

for (const lifetime of [undefined, 3_600_000]) {
  test(`after a refresh on one node, the old access token stops working on the others (#55, ${lifetime ? "with" : "without"} a lifetime)`, async () => {
    // Two nodes: one database, one cluster.
    const shared = { databaseAdapter: memoryAdapter(), cluster: localCluster(), accessTokenLifetimeMs: lifetime };
    const a = await testServer(shared);
    const b = await testServer(shared);
    try {
      await a.hs.admin.createUser("alice", { password: "password" });
      const login = await a.call("POST", "/_matrix/client/v3/login", {
        body: { type: "m.login.password", identifier: { type: "m.id.user", user: "alice" }, password: "password", refresh_token: true },
      });
      const old = login.json.access_token;
      // Node B caches the session.
      assert.equal((await b.call("GET", "/_matrix/client/v3/account/whoami", { token: old })).status, 200);
      const refreshed = await a.call("POST", "/_matrix/client/v3/refresh", { body: { refresh_token: login.json.refresh_token } });
      assert.equal(refreshed.status, 200, refreshed.text);
      assert.equal((await b.call("GET", "/_matrix/client/v3/account/whoami", { token: old })).status, 401);
      assert.equal((await b.call("GET", "/_matrix/client/v3/account/whoami", { token: refreshed.json.access_token })).status, 200);
    } finally {
      await a.close();
      await b.close();
    }
  });
}

test("a registration token registers no more accounts than it allows, even concurrently (#81)", async () => {
  const t = await testServer({ userAuthAdapter: { registrationEnabled: true, registrationRequiresToken: true }, rateLimits: false });
  try {
    const { token } = await t.hs.admin.createRegistrationToken({ token: "invite", usesAllowed: 2 });
    /** Register: the first request opens a UIA session, the second completes the token stage. */
    const register = async (username: string) => {
      const start = await t.call("POST", "/_matrix/client/v3/register", { body: { username, password: "Passw0rd!long" } });
      const session = start.json.session;
      const staged = await t.call("POST", "/_matrix/client/v3/register", {
        body: { username, password: "Passw0rd!long", auth: { type: "m.login.registration_token", token, session } },
      });
      return staged.status;
    };
    const statuses = await Promise.all(["a1", "a2", "a3", "a4", "a5"].map(register));
    assert.equal(statuses.filter((s) => s === 200).length, 2, String(statuses));
    const row = await t.hs.db.findOne("registration_tokens", [{ field: "token", value: token }]);
    assert.equal(row!.completed, 2);
  } finally {
    await t.close();
  }
});
