import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseAdapter, FieldType, Row, Schema, WhereClause } from "#storage/types.ts";

export type SqlDialect = "sqlite" | "postgres" | "mysql";

export interface SqlExecutor {
  /** Run a query that returns rows. */
  query(sql: string, params: unknown[]): Promise<Row[]>;
  /** Run a statement; resolve with the number of affected rows. */
  execute(sql: string, params: unknown[]): Promise<number>;
}

export interface SqlAdapterOptions {
  dialect: SqlDialect;
  executor: SqlExecutor;
  /** Optional prefix for all table names. */
  tablePrefix?: string;
  /**
   * Run `fn` inside a database transaction, passing an executor bound to it.
   * Without this, the adapter does not support transactions.
   */
  transaction?<T>(fn: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

const OPS: Record<string, string> = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };

/**
 * Generic SQL adapter. Works with any driver that can run parameterised
 * queries; see `sqliteAdapter` and `postgresAdapter` for ready-made wrappers.
 */
export function sqlAdapter({ dialect, executor: rootExecutor, tablePrefix = "", transaction }: SqlAdapterOptions): DatabaseAdapter {
  let schema: Schema = {};
  const q = (ident: string) => (dialect === "mysql" ? `\`${ident}\`` : `"${ident}"`);
  const t = (model: string) => q(tablePrefix + model);

  const columnType = (type: FieldType, isKey: boolean): string => {
    switch (type) {
      case "string":
        return dialect === "mysql" ? (isKey ? "VARCHAR(255)" : "TEXT") : "TEXT";
      case "number":
        return dialect === "sqlite" ? "INTEGER" : "BIGINT";
      case "boolean":
        return dialect === "postgres" ? "BOOLEAN" : "INTEGER";
      case "json":
        return dialect === "mysql" ? "LONGTEXT" : "TEXT";
    }
  };

  const columnsOf = async (executor: SqlExecutor, table: string): Promise<Set<string>> => {
    const rows =
      dialect === "sqlite"
        ? await executor.query(`PRAGMA table_info(${q(table)})`, [])
        : dialect === "postgres"
          ? await executor.query(
              "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1",
              [table],
            )
          : await executor.query(
              "SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?",
              [table],
            );
    return new Set(rows.map((r) => String(r.name)));
  };

  const fieldType = (model: string, field: string): FieldType => schema[model]?.fields[field]?.type ?? "string";

  const toDb = (model: string, field: string, value: unknown): unknown => {
    if (value === undefined || value === null) return null;
    switch (fieldType(model, field)) {
      case "json":
        return JSON.stringify(value);
      case "boolean":
        return dialect === "postgres" ? !!value : value ? 1 : 0;
      default:
        return value;
    }
  };

  const fromDb = (model: string, row: Row): Row => {
    const out: Row = {};
    for (const [field, value] of Object.entries(row)) {
      if (value === null || value === undefined) {
        out[field] = null;
        continue;
      }
      switch (fieldType(model, field)) {
        case "json":
          out[field] = typeof value === "string" ? JSON.parse(value) : value;
          break;
        case "boolean":
          out[field] = value === true || value === 1 || value === "1" || value === 1n;
          break;
        case "number":
          out[field] = Number(value);
          break;
        default:
          out[field] = value;
      }
    }
    return out;
  };

  const placeholder = (i: number) => (dialect === "postgres" ? `$${i}` : "?");

  const buildWhere = (model: string, where: WhereClause[] = [], params: unknown[]): string => {
    if (where.length === 0) return "";
    const parts = where.map((w) => {
      const op = w.operator ?? "eq";
      if (op === "in") {
        const values = w.value as unknown[];
        if (values.length === 0) return "1=0";
        const ph = values.map((v) => {
          params.push(toDb(model, w.field, v));
          return placeholder(params.length);
        });
        return `${q(w.field)} IN (${ph.join(", ")})`;
      }
      if (w.value === null || w.value === undefined) {
        if (op === "eq") return `${q(w.field)} IS NULL`;
        if (op === "ne") return `${q(w.field)} IS NOT NULL`;
      }
      params.push(toDb(model, w.field, w.value));
      return `${q(w.field)} ${OPS[op]} ${placeholder(params.length)}`;
    });
    return ` WHERE ${parts.join(" AND ")}`;
  };

  const build = (executor: SqlExecutor, inTx: boolean): DatabaseAdapter => {
    const insert = async (model: string, data: Row, mode: "insert" | "upsert") => {
      const fields = Object.keys(data).filter((k) => data[k] !== undefined);
      const params = fields.map((f) => toDb(model, f, data[f]));
      const cols = fields.map(q).join(", ");
      const ph = fields.map((_, i) => placeholder(i + 1)).join(", ");
      let sql = `INSERT INTO ${t(model)} (${cols}) VALUES (${ph})`;
      if (mode === "upsert") {
        const pk = schema[model]?.primaryKey ?? [];
        const rest = fields.filter((f) => !pk.includes(f));
        if (dialect === "mysql") {
          sql += rest.length
            ? ` ON DUPLICATE KEY UPDATE ${rest.map((f) => `${q(f)} = VALUES(${q(f)})`).join(", ")}`
            : ` ON DUPLICATE KEY UPDATE ${q(pk[0])} = ${q(pk[0])}`;
        } else {
          sql += ` ON CONFLICT (${pk.map(q).join(", ")}) DO ${
            rest.length ? `UPDATE SET ${rest.map((f) => `${q(f)} = excluded.${q(f)}`).join(", ")}` : "NOTHING"
          }`;
        }
      }
      await executor.execute(sql, params);
    };

    const adapter: DatabaseAdapter = {
      async migrate(s: Schema) {
        schema = s;
        for (const [model, def] of Object.entries(s)) {
          const cols = Object.entries(def.fields).map(([name, f]) => {
            const isKey = def.primaryKey.includes(name) || (def.indexes ?? []).some((i) => i.includes(name));
            return `${q(name)} ${columnType(f.type, isKey)}${f.required === false ? "" : " NOT NULL"}`;
          });
          cols.push(`PRIMARY KEY (${def.primaryKey.map(q).join(", ")})`);
          const ine = "IF NOT EXISTS";
          await executor.execute(`CREATE TABLE ${ine} ${t(model)} (${cols.join(", ")})`, []);
          // Fields added to a model after its table was created become nullable columns
          // (existing rows have no value for them).
          const existing = await columnsOf(executor, tablePrefix + model);
          for (const [name, f] of Object.entries(def.fields)) {
            if (existing.has(name)) continue;
            await executor.execute(`ALTER TABLE ${t(model)} ADD COLUMN ${q(name)} ${columnType(f.type, false)}`, []);
          }
          for (const index of def.indexes ?? []) {
            const name = q(`idx_${tablePrefix}${model}_${index.join("_")}`);
            if (dialect === "mysql") {
              try {
                await executor.execute(`CREATE INDEX ${name} ON ${t(model)} (${index.map(q).join(", ")})`, []);
              } catch {
                /* index already exists */
              }
            } else {
              await executor.execute(`CREATE INDEX ${ine} ${name} ON ${t(model)} (${index.map(q).join(", ")})`, []);
            }
          }
        }
      },
      create: (model, data) => insert(model, data, "insert"),
      upsert: (model, data) => insert(model, data, "upsert"),
      async findOne(model, where) {
        const params: unknown[] = [];
        const rows = await executor.query(`SELECT * FROM ${t(model)}${buildWhere(model, where, params)} LIMIT 1`, params);
        return rows[0] ? fromDb(model, rows[0]) : null;
      },
      async findMany(model, opts = {}) {
        const params: unknown[] = [];
        let sql = `SELECT * FROM ${t(model)}${buildWhere(model, opts.where, params)}`;
        if (opts.sortBy) sql += ` ORDER BY ${q(opts.sortBy.field)} ${opts.sortBy.direction === "asc" ? "ASC" : "DESC"}`;
        if (opts.limit !== undefined) sql += ` LIMIT ${Math.max(0, Math.floor(opts.limit))}`;
        const rows = await executor.query(sql, params);
        return rows.map((r) => fromDb(model, r));
      },
      async update(model, where, data) {
        const fields = Object.keys(data).filter((k) => data[k] !== undefined);
        if (fields.length === 0) return 0;
        const params: unknown[] = fields.map((f) => toDb(model, f, data[f]));
        const set = fields.map((f, i) => `${q(f)} = ${placeholder(i + 1)}`).join(", ");
        return executor.execute(`UPDATE ${t(model)} SET ${set}${buildWhere(model, where, params)}`, params);
      },
      async delete(model, where) {
        const params: unknown[] = [];
        return executor.execute(`DELETE FROM ${t(model)}${buildWhere(model, where, params)}`, params);
      },
      async max(model, field) {
        const rows = await executor.query(`SELECT MAX(${q(field)}) AS m FROM ${t(model)}`, []);
        const m = rows[0]?.m;
        return m === null || m === undefined ? null : Number(m);
      },
    };
    if (transaction) {
      adapter.transaction = <T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> =>
        inTx ? fn(adapter) : transaction((ex) => fn(build(ex, true)));
    }
    return adapter;
  };
  return build(rootExecutor, false);
}

/** Minimal structural type matching `node:sqlite` DatabaseSync and `better-sqlite3`. */
export interface SqliteDatabaseLike {
  exec(sql: string): unknown;
  prepare(sql: string): {
    all(...params: any[]): unknown[];
    run(...params: any[]): { changes: number | bigint };
  };
}

/** SQLite adapter for `node:sqlite` (`new DatabaseSync(path)`) or `better-sqlite3`. */
export function sqliteAdapter(db: SqliteDatabaseLike, options: { tablePrefix?: string } = {}): DatabaseAdapter {
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    /* in-memory databases */
  }
  const cache = new Map<string, ReturnType<SqliteDatabaseLike["prepare"]>>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  // A single connection is shared, so statements from other requests must wait
  // while a transaction is open. Code running inside the transaction bypasses the gate.
  const inTransaction = new AsyncLocalStorage<boolean>();
  let gate: Promise<void> = Promise.resolve();
  const waitGate = async () => {
    if (!inTransaction.getStore()) await gate;
  };
  const executor: SqlExecutor = {
    async query(sql, params) {
      await waitGate();
      return stmt(sql).all(...params) as Row[];
    },
    async execute(sql, params) {
      await waitGate();
      return Number(stmt(sql).run(...params).changes);
    },
  };
  return sqlAdapter({
    dialect: "sqlite",
    tablePrefix: options.tablePrefix,
    executor,
    async transaction(fn) {
      // Already inside a transaction (on this async path): join it instead of deadlocking on the gate.
      if (inTransaction.getStore()) return fn(executor);
      const previous = gate;
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      await previous;
      try {
        return await inTransaction.run(true, async () => {
          db.exec("BEGIN IMMEDIATE");
          try {
            const result = await fn(executor);
            db.exec("COMMIT");
            return result;
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
        });
      } finally {
        release();
      }
    },
  });
}

interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/** Minimal structural type matching `pg.Pool` (or a single `pg.Client`). */
export interface PgPoolLike extends PgQueryable {
  /** Present on pools; enables transactions on a dedicated connection. */
  connect?(): Promise<PgQueryable & { release(): void }>;
}

const pgExecutor = (conn: PgQueryable): SqlExecutor => ({
  async query(sql, params) {
    return (await conn.query(sql, params)).rows;
  },
  async execute(sql, params) {
    return (await conn.query(sql, params)).rowCount ?? 0;
  },
});

/** PostgreSQL adapter for `pg` (node-postgres). Pass a `Pool` to get transactions. */
export function postgresAdapter(pool: PgPoolLike, options: { tablePrefix?: string } = {}): DatabaseAdapter {
  return sqlAdapter({
    dialect: "postgres",
    tablePrefix: options.tablePrefix,
    executor: pgExecutor(pool),
    transaction: pool.connect
      ? async (fn) => {
          const client = await pool.connect!();
          try {
            await client.query("BEGIN");
            const result = await fn(pgExecutor(client));
            await client.query("COMMIT");
            return result;
          } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
          } finally {
            client.release();
          }
        }
      : undefined,
  });
}

interface MysqlQueryable {
  query(sql: string, values?: unknown[]): Promise<[any, unknown]>;
}

/** Minimal structural type matching `mysql2/promise` pools. */
export interface MysqlPoolLike extends MysqlQueryable {
  /** Present on pools; enables transactions on a dedicated connection. */
  getConnection?(): Promise<MysqlQueryable & { release(): void }>;
}

const mysqlExecutor = (conn: MysqlQueryable): SqlExecutor => ({
  async query(sql, params) {
    return (await conn.query(sql, params))[0] as Row[];
  },
  async execute(sql, params) {
    return (await conn.query(sql, params))[0]?.affectedRows ?? 0;
  },
});

/** MySQL / MariaDB adapter for `mysql2/promise` pools. */
export function mysqlAdapter(pool: MysqlPoolLike, options: { tablePrefix?: string } = {}): DatabaseAdapter {
  return sqlAdapter({
    dialect: "mysql",
    tablePrefix: options.tablePrefix,
    executor: mysqlExecutor(pool),
    transaction: pool.getConnection
      ? async (fn) => {
          const conn = await pool.getConnection!();
          try {
            await conn.query("START TRANSACTION");
            const result = await fn(mysqlExecutor(conn));
            await conn.query("COMMIT");
            return result;
          } catch (err) {
            await conn.query("ROLLBACK").catch(() => {});
            throw err;
          } finally {
            conn.release();
          }
        }
      : undefined,
  });
}
