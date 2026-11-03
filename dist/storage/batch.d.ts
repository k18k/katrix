import type { BatchQuery, DatabaseAdapter, Row } from "#storage/types.ts";
/**
 * Run independent reads together: in one round trip when the adapter can (`findManyBatch`),
 * otherwise concurrently. Results come in the order of the queries.
 */
export declare function readBatch(db: DatabaseAdapter, queries: BatchQuery[]): Promise<Row[][]>;
/** Upsert several rows: in a few statements when the adapter can (`upsertMany`), otherwise one by one. */
export declare function upsertMany(db: DatabaseAdapter, model: string, rows: Row[]): Promise<void>;
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
export declare function coalesceReads(db: DatabaseAdapter): DatabaseAdapter;
