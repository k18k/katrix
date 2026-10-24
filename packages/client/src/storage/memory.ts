import type { StorageAdapter, StoreName, WriteOp } from "./adapter.ts";

/**
 * In-memory storage: state lives as long as the process. Values are stored as the strings the
 * client writes, so state is copied in and out exactly as with a durable adapter.
 */
export class MemoryStorage implements StorageAdapter {
  private stores = new Map<StoreName, Map<string, string>>();

  private store(name: StoreName): Map<string, string> {
    let s = this.stores.get(name);
    if (!s) this.stores.set(name, (s = new Map()));
    return s;
  }

  async get(store: StoreName, key: string): Promise<string | undefined> {
    return this.stores.get(store)?.get(key);
  }

  async list(store: StoreName, prefix: string): Promise<Array<[string, string]>> {
    const out: Array<[string, string]> = [];
    for (const entry of this.stores.get(store) ?? []) if (entry[0].startsWith(prefix)) out.push(entry);
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  /** Synchronous inside, so no other operation can see half of a batch. */
  async write(batch: readonly WriteOp[]): Promise<void> {
    for (const op of batch) {
      if (op.type === "put") this.store(op.store).set(op.key, op.value);
      else this.stores.get(op.store)?.delete(op.key);
    }
  }
}

export function memoryStorage(): MemoryStorage {
  return new MemoryStorage();
}
