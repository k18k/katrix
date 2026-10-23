import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { postgresAdapter, postgresCluster, CONFORMANCE_SCHEMA } from "#index.ts";

// Postgres dropping every connection (as on a restart) must cost failed queries, not the process (#91).
// Runs when PG_TEST_URL is set (CI starts a Postgres).
const url = process.env.PG_TEST_URL;

/** Terminate every other connection to the database, as a Postgres restart does. */
async function dropConnections(): Promise<void> {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database()",
  );
  await admin.end();
}

test("the Postgres adapters survive their connections being dropped (#91)", { skip: url ? false : "PG_TEST_URL not set" }, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const clusterPool = new pg.Pool({ connectionString: url, max: 2 });
  const prefix = `t${randomBytes(4).toString("hex")}_`;
  const db = postgresAdapter(pool, { tablePrefix: prefix });
  const cluster = postgresCluster(clusterPool, { tablePrefix: prefix });
  try {
    await db.migrate!(CONFORMANCE_SCHEMA);
    await cluster.nextId("seq");
    // Idle clients in both pools, plus the cluster's LISTEN connection.
    await Promise.all([db.findMany("conformance_items"), db.findMany("conformance_items"), cluster.currentId("seq")]);
    await dropConnections();
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Still running; new queries get new connections.
    assert.deepEqual(await db.findMany("conformance_items"), []);
    assert.equal(await cluster.nextId("seq"), 2);
    await db.transaction!(async (tx) => tx.create("conformance_items", { owner: "a", id: 1, label: null, flag: false, data: {} }));
    assert.equal((await db.findMany("conformance_items")).length, 1);
  } finally {
    await cluster.close?.();
    await pool.end();
    await clusterPool.end();
  }
});
