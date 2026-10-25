import type { StorageAdapter, StoreName, WriteOp } from "../storage/adapter.ts";
import { Mutex } from "../util/mutex.ts";

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

/** Above every character a key can continue with (keys compare as UTF-8 bytes, that is, by code point). */
const PREFIX_END = "\u{10FFFF}";

class SqliteStorage implements StorageAdapter {
  private readonly db: SqlExecutor;
  private readonly table: string;
  private readonly mutex = new Mutex();
  private ready?: Promise<void>;

  constructor(db: SqlExecutor, table: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("Invalid table name");
    this.db = db;
    this.table = table;
  }

  private init(): Promise<void> {
    this.ready ??= this.mutex.run(async () => {
      await this.db.run(
        `CREATE TABLE IF NOT EXISTS ${this.table} (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key)) WITHOUT ROWID`,
        [],
      );
    });
    return this.ready;
  }

  async get(store: StoreName, key: string): Promise<string | undefined> {
    await this.init();
    return this.mutex.run(async () => {
      const rows = await this.db.all(`SELECT value FROM ${this.table} WHERE store = ? AND key = ?`, [store, key]);
      const value = rows[0]?.value;
      return typeof value === "string" ? value : undefined;
    });
  }

  async list(store: StoreName, prefix: string): Promise<Array<[string, string]>> {
    await this.init();
    return this.mutex.run(async () => {
      const rows = await this.db.all(`SELECT key, value FROM ${this.table} WHERE store = ? AND key >= ? AND key < ? ORDER BY key`, [
        store,
        prefix,
        prefix + PREFIX_END,
      ]);
      return rows.map((r) => [String(r.key), String(r.value)] as [string, string]);
    });
  }

  async write(batch: readonly WriteOp[]): Promise<void> {
    if (batch.length === 0) return;
    await this.init();
    await this.mutex.run(async () => {
      await this.db.run("BEGIN IMMEDIATE", []);
      try {
        for (const op of batch) {
          if (op.type === "put")
            await this.db.run(
              `INSERT INTO ${this.table} (store, key, value) VALUES (?, ?, ?) ON CONFLICT (store, key) DO UPDATE SET value = excluded.value`,
              [op.store, op.key, op.value],
            );
          else await this.db.run(`DELETE FROM ${this.table} WHERE store = ? AND key = ?`, [op.store, op.key]);
        }
        await this.db.run("COMMIT", []);
      } catch (e) {
        try {
          await this.db.run("ROLLBACK", []);
        } catch {
          // The transaction may already be gone (SQLite rolls back on some errors by itself).
        }
        throw e;
      }
    });
  }
}

/** Storage in an SQLite database (the table is created on first use; `table` defaults to "katrix"). */
export function sqliteStorage(db: SqlExecutor, opts: { table?: string } = {}): StorageAdapter {
  return new SqliteStorage(db, opts.table ?? "katrix");
}
