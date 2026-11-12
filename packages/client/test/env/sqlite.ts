import { DatabaseSync } from "node:sqlite";
import type { SqlExecutor } from "../../src/adapters/sqlite.ts";

/** The SQLite adapter's executor on node:sqlite, as the adapter's documentation shows it. */
export function nodeSqlite(path: string): SqlExecutor & { db: DatabaseSync } {
  const db = new DatabaseSync(path);
  return {
    db,
    run: (sql, params) => void db.prepare(sql).run(...(params as never[])),
    all: (sql, params) => db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>,
  };
}
