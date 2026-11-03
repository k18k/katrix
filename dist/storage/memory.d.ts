import type { StorageAdapter, StoreName, WriteOp } from "./adapter.ts";
/**
 * In-memory storage: state lives as long as the process. Values are stored as the strings the
 * client writes, so state is copied in and out exactly as with a durable adapter.
 */
export declare class MemoryStorage implements StorageAdapter {
    private stores;
    private store;
    get(store: StoreName, key: string): Promise<string | undefined>;
    list(store: StoreName, prefix: string): Promise<Array<[string, string]>>;
    /** Synchronous inside, so no other operation can see half of a batch. */
    write(batch: readonly WriteOp[]): Promise<void>;
}
export declare function memoryStorage(): MemoryStorage;
