import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { adapterConformance, CONFORMANCE_SCHEMA, memoryAdapter, postgresAdapter, sqliteAdapter, type DatabaseAdapter } from "#index.ts";

// The bundled adapters keep the DatabaseAdapter contract (#58). Postgres runs when PG_TEST_URL is set
// (CI starts one); each check gets its own table prefix there.

const pool = process.env.PG_TEST_URL ? new pg.Pool({ connectionString: process.env.PG_TEST_URL }) : null;

const BACKENDS: Record<string, (() => DatabaseAdapter) | null> = {
  memory: () => memoryAdapter(),
  sqlite: () => sqliteAdapter(new DatabaseSync(":memory:")),
  postgres: pool ? () => postgresAdapter(pool, { tablePrefix: `t${randomBytes(4).toString("hex")}_` }) : null,
};

for (const [backend, make] of Object.entries(BACKENDS)) {
  for (const check of adapterConformance) {
    test(`${backend}: ${check.name}`, { skip: make ? false : "PG_TEST_URL not set" }, async () => {
      const db = make!();
      await db.migrate?.(CONFORMANCE_SCHEMA);
      await check.run(db);
    });
  }
}

if (pool) test.after(() => pool.end());
