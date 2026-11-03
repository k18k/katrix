import type { DatabaseAdapter, Row, WhereClause } from "#storage/types.ts";
export declare function matches(row: Row, where?: WhereClause[]): boolean;
/** In-memory adapter. Data is lost on restart; useful for tests and development. */
export declare function memoryAdapter(): DatabaseAdapter;
