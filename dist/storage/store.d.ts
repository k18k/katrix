import { StorageAdapter, StoreName } from "./adapter.js";
export declare class Store {
  private readonly adapter;
  private readonly mutex;
  constructor(adapter: StorageAdapter);
  /** Read committed state, outside any unit of work. */
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  list<T>(store: StoreName, prefix?: string): Promise<Array<[string, T]>>;
  /** Run `task` as one unit of work. Its writes are applied atomically after it returns. */
  transaction<T>(task: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export declare class Transaction {
  private readonly adapter;
  /** Pending writes, by store and key: a later write to the same key replaces the earlier one. */
  private pending;
  private committed;
  private afterCommit;
  constructor(adapter: StorageAdapter);
  private static id;
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  list<T>(store: StoreName, prefix?: string): Promise<Array<[string, T]>>;
  put(store: StoreName, key: string, value: unknown): void;
  delete(store: StoreName, key: string): void;
  /** Run `fn` once the batch is durable (for example, emit events about what was stored). */
  onCommit(fn: () => void): void;
  private assertOpen;
  commit(): Promise<void>;
}
//# sourceMappingURL=store.d.ts.map