import { StorageAdapter, StoreName, WriteOp } from "../storage/adapter.js";
/**
 * A StorageAdapter on SQLite, through the smallest interface SQLite libraries share: run a
 * statement, and fetch rows. It fits node:sqlite's DatabaseSync and better-sqlite3 (sync), and
 * React Native's op-sqlite or expo-sqlite (async) with a few lines of glue:
 *
 *   import { DatabaseSync } from "node:sqlite";
 *   const db = new DatabaseSync("katrix.db");
 *   const storage = sqliteStorage({
 *     run: (sql, params) => void db.prepare(sql).run(...params),
 *     all: (sql, params) => db.prepare(sql).all(...params),
 *   });
 *
 * One table holds every store: (store, key) → value. A batch is one transaction (BEGIN
 * IMMEDIATE … COMMIT, ROLLBACK on error). The connection is used by one operation at a time, so
 * a read never sees half of a batch.
 */
export interface SqlExecutor {
  run(sql: string, params: unknown[]): void | Promise<void>;
  all(sql: string, params: unknown[]): Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>;
}
declare class SqliteStorage implements StorageAdapter {
  private readonly db;
  private readonly table;
  private readonly mutex;
  private ready?;
  constructor(db: SqlExecutor, table: string);
  private init;
  get(store: StoreName, key: string): Promise<string | undefined>;
  list(store: StoreName, prefix: string): Promise<[string, string][]>;
  write(batch: readonly WriteOp[]): Promise<void>;
}
/** Storage in an SQLite database (the table is created on first use; `table` defaults to "katrix"). */
export declare function sqliteStorage(db: SqlExecutor, opts?: {
  table?: string;
}): SqliteStorage;
export {};
//# sourceMappingURL=sqlite.d.ts.map