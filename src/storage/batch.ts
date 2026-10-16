import type { BatchQuery, DatabaseAdapter, Row } from "#storage/types.ts";

/**
 * Run independent reads together: in one round trip when the adapter can (`findManyBatch`),
 * otherwise concurrently. Results come in the order of the queries.
 */
export function readBatch(db: DatabaseAdapter, queries: BatchQuery[]): Promise<Row[][]> {
  if (db.findManyBatch) return db.findManyBatch(queries);
  return Promise.all(queries.map((query) => db.findMany(query.model, query.opts)));
}
