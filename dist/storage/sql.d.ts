import type { DatabaseAdapter, Row } from "#storage/types.ts";
export type SqlDialect = "sqlite" | "postgres" | "mysql";
export interface SqlExecutor {
    /** Run a query that returns rows; `prepare: false` when the statement is not worth preparing for reuse. */
    query(sql: string, params: unknown[], options?: {
        prepare?: boolean;
    }): Promise<Row[]>;
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
/**
 * Generic SQL adapter. Works with any driver that can run parameterised
 * queries; see `sqliteAdapter` and `postgresAdapter` for ready-made wrappers.
 */
export declare function sqlAdapter({ dialect, executor: rootExecutor, tablePrefix, transaction }: SqlAdapterOptions): DatabaseAdapter;
/** Minimal structural type matching `node:sqlite` DatabaseSync and `better-sqlite3`. */
export interface SqliteDatabaseLike {
    exec(sql: string): unknown;
    prepare(sql: string): {
        all(...params: any[]): unknown[];
        run(...params: any[]): {
            changes: number | bigint;
        };
    };
}
/** SQLite adapter for `node:sqlite` (`new DatabaseSync(path)`) or `better-sqlite3`. */
export declare function sqliteAdapter(db: SqliteDatabaseLike, options?: {
    tablePrefix?: string;
    /**
     * When commits reach the disk (SQLite's `synchronous`). `"normal"` (the default): at
     * checkpoints; a commit survives a crash of the process, and a power loss or operating
     * system crash can roll back the most recent ones, without corrupting the database.
     * `"full"`: on every commit, which blocks the event loop for an fsync each time.
     */
    synchronous?: "normal" | "full";
}): DatabaseAdapter;
interface PgQueryable {
    query(config: {
        text: string;
        values?: unknown[];
        name?: string;
    }): Promise<{
        rows: Row[];
        rowCount: number | null;
    }>;
    on?(event: "error", listener: (err: Error) => void): unknown;
    off?(event: "error", listener: (err: Error) => void): unknown;
}
/** Minimal structural type matching `pg.Pool` (or a single `pg.Client`). */
export interface PgPoolLike extends PgQueryable {
    /** Present on pools; enables transactions on a dedicated connection. */
    connect?(): Promise<PgQueryable & {
        release(): void;
    }>;
}
/**
 * https://github.com/k18k/katrix/issues/91: when Postgres restarts or drops a connection, `pg`
 * emits "error" on the pool (for idle clients) and on a checked-out client between two queries. Unheard, that
 * event ended the process. The pool replaces broken idle clients, and a query on a broken client fails on its
 * own, so the event needs no more than a listener.
 */
export declare const ignorePgError: () => void;
/** PostgreSQL adapter for `pg` (node-postgres). Pass a `Pool` to get transactions. */
export declare function postgresAdapter(pool: PgPoolLike, options?: {
    tablePrefix?: string;
    /**
     * Prepare statements on each connection and reuse them (default true). Turn off behind a
     * connection pooler that does not support prepared statements, such as PgBouncer before 1.21
     * or in transaction mode without `max_prepared_statements`.
     */
    preparedStatements?: boolean;
}): DatabaseAdapter;
interface MysqlQueryable {
    query(sql: string, values?: unknown[]): Promise<[any, unknown]>;
}
/** Minimal structural type matching `mysql2/promise` pools. */
export interface MysqlPoolLike extends MysqlQueryable {
    /** Present on pools; enables transactions on a dedicated connection. */
    getConnection?(): Promise<MysqlQueryable & {
        release(): void;
    }>;
}
/** MySQL / MariaDB adapter for `mysql2/promise` pools. */
export declare function mysqlAdapter(pool: MysqlPoolLike, options?: {
    tablePrefix?: string;
}): DatabaseAdapter;
export {};
