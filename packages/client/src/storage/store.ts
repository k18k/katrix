import { Mutex } from "../util/mutex.ts";
import type { StorageAdapter, StoreName, WriteOp } from "./adapter.ts";

/**
 * The client's view of storage: typed JSON values, and units of work. A unit of work reads
 * through its own pending writes and commits them as one atomic batch at the end; if the task
 * throws, nothing is written. Units of work run one at a time (the client is the single writer),
 * so two of them never read the same state and overwrite each other's changes.
 *
 * Network calls inside a unit of work are allowed (the batch is only handed to the adapter at
 * the end), which lets one /sync response, its to-device messages and the new sync token be
 * committed together.
 */
export class Store {
  private readonly adapter: StorageAdapter;
  private readonly mutex = new Mutex();

  constructor(adapter: StorageAdapter) {
    this.adapter = adapter;
  }

  /** Read committed state, outside any unit of work. */
  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const raw = await this.adapter.get(store, key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async list<T>(store: StoreName, prefix = ""): Promise<Array<[string, T]>> {
    return (await this.adapter.list(store, prefix)).map(([k, v]) => [k, JSON.parse(v) as T]);
  }

  /** Run `task` as one unit of work. Its writes are applied atomically after it returns. */
  transaction<T>(task: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const tx = new Transaction(this.adapter);
      const result = await task(tx);
      await tx.commit();
      return result;
    });
  }

  close(): Promise<void> {
    return this.mutex.run(async () => {
      await this.adapter.close?.();
    });
  }
}

export class Transaction {
  private readonly adapter: StorageAdapter;
  /** Pending writes, by store and key: a later write to the same key replaces the earlier one. */
  private pending = new Map<string, WriteOp>();
  private committed = false;
  private afterCommit: Array<() => void> = [];

  constructor(adapter: StorageAdapter) {
    this.adapter = adapter;
  }

  private static id(store: StoreName, key: string) {
    return `${store}\u0000${key}`;
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const op = this.pending.get(Transaction.id(store, key));
    if (op) return op.type === "put" ? (JSON.parse(op.value) as T) : undefined;
    const raw = await this.adapter.get(store, key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async list<T>(store: StoreName, prefix = ""): Promise<Array<[string, T]>> {
    const merged = new Map<string, string>(await this.adapter.list(store, prefix));
    for (const op of this.pending.values()) {
      if (op.store !== store || !op.key.startsWith(prefix)) continue;
      if (op.type === "put") merged.set(op.key, op.value);
      else merged.delete(op.key);
    }
    return [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => [k, JSON.parse(v) as T]);
  }

  put(store: StoreName, key: string, value: unknown): void {
    this.assertOpen();
    this.pending.set(Transaction.id(store, key), { type: "put", store, key, value: JSON.stringify(value) });
  }

  delete(store: StoreName, key: string): void {
    this.assertOpen();
    this.pending.set(Transaction.id(store, key), { type: "delete", store, key });
  }

  /** Run `fn` once the batch is durable (for example, emit events about what was stored). */
  onCommit(fn: () => void): void {
    this.afterCommit.push(fn);
  }

  private assertOpen() {
    if (this.committed) throw new Error("Write after the unit of work was committed");
  }

  async commit(): Promise<void> {
    this.assertOpen();
    this.committed = true;
    if (this.pending.size > 0) await this.adapter.write([...this.pending.values()]);
    for (const fn of this.afterCommit) fn();
  }
}
