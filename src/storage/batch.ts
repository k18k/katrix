import type { BatchQuery, DatabaseAdapter, Row } from "#storage/types.ts";

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
