import { type ClusterAdapter } from "#core/cluster.ts";
export { localCluster, type ClusterAdapter } from "#core/cluster.ts";
interface PgClientLike {
    query(text: string, values?: unknown[]): Promise<{
        rows: any[];
        rowCount: number | null;
    }>;
    /** `release(err)` closes the connection instead of returning it to the pool. */
    release(err?: Error | boolean): void;
    on(event: "notification", listener: (msg: {
        channel: string;
        payload?: string;
    }) => void): unknown;
    on(event: "error" | "end", listener: (err?: Error) => void): unknown;
}
export interface PgClusterPoolLike {
    query(text: string, values?: unknown[]): Promise<{
        rows: any[];
        rowCount: number | null;
    }>;
    connect(): Promise<PgClientLike>;
    on?(event: "error", listener: (err: Error) => void): unknown;
}
/**
 * Cluster adapter backed by PostgreSQL (`pg` Pool): sequences, leased locks,
 * LISTEN/NOTIFY pub/sub and an expiring key-value table. Lets several homeserver
 * instances share one database.
 */
export declare function postgresCluster(pool: PgClusterPoolLike, options?: {
    tablePrefix?: string;
}): ClusterAdapter;
