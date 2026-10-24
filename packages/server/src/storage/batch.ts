import type { BatchQuery, DatabaseAdapter, Row, Schema } from "#storage/types.ts";

/**
 * Run independent reads together: in one round trip when the adapter can (`findManyBatch`),
 * otherwise concurrently. Results come in the order of the queries.
 */
export function readBatch(db: DatabaseAdapter, queries: BatchQuery[]): Promise<Row[][]> {
  if (db.findManyBatch) return db.findManyBatch(queries);
  return Promise.all(queries.map((query) => db.findMany(query.model, query.opts)));
}

/** Upsert several rows: in a few statements when the adapter can (`upsertMany`), otherwise one by one. */
export async function upsertMany(db: DatabaseAdapter, model: string, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  if (db.upsertMany) return db.upsertMany(model, rows);
  for (const row of rows) await db.upsert(model, row);
}

interface PendingRead {
  query: BatchQuery;
  resolve: (rows: Row[]) => void;
  reject: (err: unknown) => void;
}

/** At most this many reads go into one coalesced statement. */
const MAX_COALESCED = 32;

/**
 * An adapter whose reads (`findMany`, `findOne`) issued within one turn of the event loop are
 * sent together, through `findManyBatch`. Writes and transactions go straight to `db`. Adapters
 * without `findManyBatch` are returned as they are.
 *
 * https://github.com/k18k/katrix/issues/43: under load, most of the homeserver's
 * and the database's CPU went to the per-statement cost (a socket write, a round trip, parsing)
 * of many small reads issued at the same moment by concurrent requests. Nothing is kept between
 * turns: this merges requests, it does not cache results. A read waits for at most the rest of
 * the current turn. If a coalesced statement fails, its reads are run one by one, so a bad read
 * fails alone.
 */
export function coalesceReads(db: DatabaseAdapter): DatabaseAdapter {
  if (!db.findManyBatch) return db;
  let queue: PendingRead[] = [];
  const runAlone = (read: PendingRead) => db.findMany(read.query.model, read.query.opts).then(read.resolve, read.reject);
  const run = async (reads: PendingRead[]) => {
    if (reads.length === 1) return runAlone(reads[0]);
    let results: Row[][];
    try {
      results = await db.findManyBatch!(
        reads.map((r) => r.query),
        { prepare: false },
      );
    } catch {
      for (const read of reads) void runAlone(read);
      return;
    }
    reads.forEach((read, i) => read.resolve(results[i]));
  };
  const flush = () => {
    const reads = queue;
    queue = [];
    for (let i = 0; i < reads.length; i += MAX_COALESCED) void run(reads.slice(i, i + MAX_COALESCED));
  };
  const enqueue = (query: BatchQuery) =>
    new Promise<Row[]>((resolve, reject) => {
      if (queue.length === 0) setImmediate(flush);
      queue.push({ query, resolve, reject });
    });
  return {
    findMany: (model, opts) => enqueue({ model, opts }),
    findOne: async (model, where) => (await enqueue({ model, opts: { where, limit: 1 } }))[0] ?? null,
    findManyBatch: (queries, options) => db.findManyBatch!(queries, options),
    create: (model, data) => db.create(model, data),
    upsert: (model, data) => db.upsert(model, data),
    ...(db.upsertMany ? { upsertMany: (model: string, rows: Row[]) => db.upsertMany!(model, rows) } : {}),
    update: (model, where, data) => db.update(model, where, data),
    delete: (model, where) => db.delete(model, where),
    max: (model, field) => db.max(model, field),
    ...(db.migrate ? { migrate: (schema: Schema) => db.migrate!(schema) } : {}),
    ...(db.transaction ? { transaction: <T>(fn: (tx: DatabaseAdapter) => Promise<T>) => db.transaction!(fn) } : {}),
  };
}
