export type FieldType = "string" | "number" | "boolean" | "json";

export interface FieldDef {
  type: FieldType;
  /** Defaults to true. Nullable fields may be omitted on create. */
  required?: boolean;
}

export interface ModelDef {
  fields: Record<string, FieldDef>;
  /** Primary key, possibly composite. */
  primaryKey: string[];
  /** Secondary indexes to create (SQL adapters). */
  indexes?: string[][];
}

export type Schema = Record<string, ModelDef>;

export type Operator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in";

export interface WhereClause {
  field: string;
  value: unknown;
  /** Defaults to "eq". */
  operator?: Operator;
}

export type Row = Record<string, any>;

/** How a `findManyBatch` is run. */
export interface BatchOptions {
  /**
   * The combination of reads is a one-off (as when unrelated reads are coalesced), so preparing
   * the statement for reuse would only fill the database's statement cache. Default true.
   */
  prepare?: boolean;
}

/** One read of a `findManyBatch`. */
export interface BatchQuery {
  model: string;
  opts?: FindManyOptions;
}

export interface FindManyOptions {
  where?: WhereClause[];
  /**
   * Only these fields are needed. Adapters should read just these (a smaller query and less to
   * parse); one that ignores the option and returns whole rows is still correct.
   */
  fields?: string[];
  sortBy?: { field: string; direction: "asc" | "desc" };
  limit?: number;
}

/**
 * A storage backend. Implement this interface to plug in any database
 * (the "raw adapter"), or use one of the bundled adapters.
 * All `where` clauses are combined with AND.
 *
 * What the homeserver relies on (`adapterConformance` checks it; run it against your adapter):
 * - **Durability**: a write whose promise resolved survives a restart (except `memoryAdapter`).
 * - **Atomic single operations**: each `create`, `upsert`, `update` and `delete` call applies
 *   completely or not at all, also under concurrency. `create` rejects an existing primary key
 *   (exactly one of concurrent creates succeeds). `update` and `delete` resolve to the number of
 *   rows they changed, and of concurrent deletes of a row exactly one reports it: single-use
 *   tokens are redeemed this way.
 * - **Transactions**: `transaction(fn)` applies all writes made through `tx` or none (when `fn`
 *   throws, the error reaches the caller). Reads through `tx` see its own writes. Nothing stronger
 *   than read-committed isolation is assumed: conflicting writers (room events, sequences) are
 *   serialised by the cluster adapter's locks, not by the database. Without `transaction`, a
 *   crash between the writes of one room event can leave it half stored; the homeserver warns
 *   at startup (#58).
 * - **Ordering**: rows come back in no particular order unless `sortBy` is given; `limit` applies
 *   after sorting.
 * - **Values**: every field type round-trips unchanged (JSON values, booleans, integers up to
 *   `Number.MAX_SAFE_INTEGER`, Unicode strings); a `null` in `where` matches nothing.
 * - **Schema**: `migrate` is idempotent and keeps existing rows, and adds columns introduced by
 *   newer versions.
 *
 * Deployment limits of the bundled adapters: `memoryAdapter` keeps nothing across restarts;
 * `sqliteAdapter` serves one process; several instances need a shared server database
 * (`postgresAdapter`, `mysqlAdapter`) together with `postgresCluster`.
 */
export interface DatabaseAdapter {
  /**
   * Several independent reads in one go: the results in the same order as the queries. Optional;
   * an adapter that talks to a database server can send them in one round trip. Without it,
   * callers run the reads separately (see `readBatch`).
   */
  findManyBatch?(queries: BatchQuery[], options?: BatchOptions): Promise<Row[][]>;
  /** Create tables / collections for the given schema. Must be idempotent. */
  migrate?(schema: Schema): Promise<void>;
  create(model: string, data: Row): Promise<void>;
  /** Insert or replace by primary key. */
  upsert(model: string, data: Row): Promise<void>;
  /**
   * `upsert` for several rows at once (the last row wins when two share a primary key). Optional;
   * an adapter that talks to a database server can write them in a few statements. Without it,
   * callers upsert the rows one by one (see `upsertMany`).
   */
  upsertMany?(model: string, rows: Row[]): Promise<void>;
  findOne(model: string, where: WhereClause[]): Promise<Row | null>;
  findMany(model: string, options?: FindManyOptions): Promise<Row[]>;
  update(model: string, where: WhereClause[], data: Row): Promise<number>;
  delete(model: string, where: WhereClause[]): Promise<number>;
  /** Maximum value of a numeric field, or null if there are no rows. */
  max(model: string, field: string): Promise<number | null>;
  /**
   * Run `fn` atomically: either all of its writes are applied or none are.
   * Optional; without it, writes are applied one by one.
   */
  transaction?<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T>;
}
