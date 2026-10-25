import { STORES, type StorageAdapter, type StoreName, type WriteOp } from "../storage/adapter.ts";

/**
 * A StorageAdapter on IndexedDB, for browsers: one object store per client store, one readwrite
 * transaction per batch (all or nothing; IndexedDB aborts the whole transaction on any error).
 * Values are the strings the client writes.
 *
 * One client per database: two tabs on the same database would overwrite each other's crypto
 * state (see StorageAdapter); give each account its own `name`, and keep one tab active (Web
 * Locks) or one database per tab.
 */

// The few IndexedDB types used, declared here: the SDK compiles without the DOM library.
interface IDBRequestLike<T> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}
interface IDBOpenRequestLike extends IDBRequestLike<IDBDatabaseLike> {
  onupgradeneeded: (() => void) | null;
  onblocked: (() => void) | null;
}
interface IDBObjectStoreLike {
  get(key: string): IDBRequestLike<unknown>;
  getAll(range: unknown): IDBRequestLike<unknown[]>;
  getAllKeys(range: unknown): IDBRequestLike<unknown[]>;
  put(value: string, key: string): IDBRequestLike<unknown>;
  delete(key: string): IDBRequestLike<unknown>;
}
interface IDBTransactionLike {
  objectStore(name: string): IDBObjectStoreLike;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: unknown;
}
interface IDBDatabaseLike {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(
    stores: string[],
    mode: "readonly" | "readwrite",
    options?: { durability?: "strict" | "relaxed" | "default" },
  ): IDBTransactionLike;
  close(): void;
}
export interface IDBFactoryLike {
  open(name: string, version: number): IDBOpenRequestLike;
}
export interface IDBKeyRangeLike {
  bound(lower: string, upper: string, lowerOpen?: boolean, upperOpen?: boolean): unknown;
}

function request<T>(r: IDBRequestLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const VERSION = 1;

class IndexedDbStorage implements StorageAdapter {
  private readonly db: Promise<IDBDatabaseLike>;
  private readonly keyRange: IDBKeyRangeLike;

  constructor(factory: IDBFactoryLike, keyRange: IDBKeyRangeLike, name: string) {
    this.keyRange = keyRange;
    this.db = new Promise((resolve, reject) => {
      const open = factory.open(name, VERSION);
      open.onupgradeneeded = () => {
        for (const store of STORES) if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error("The database is open elsewhere with an older version"));
    });
  }

  async get(store: StoreName, key: string): Promise<string | undefined> {
    const db = await this.db;
    const value = await request(db.transaction([store], "readonly").objectStore(store).get(key));
    return typeof value === "string" ? value : undefined;
  }

  async list(store: StoreName, prefix: string): Promise<Array<[string, string]>> {
    const db = await this.db;
    const s = db.transaction([store], "readonly").objectStore(store);
    // Keys compare by UTF-16 code units: "￿" sorts after anything a key can continue with.
    const range = this.keyRange.bound(prefix, `${prefix}￿`, false, false);
    const [keys, values] = await Promise.all([request(s.getAllKeys(range)), request(s.getAll(range))]);
    return keys.map((k, i) => [String(k), String(values[i])] as [string, string]);
  }

  async write(batch: readonly WriteOp[]): Promise<void> {
    if (batch.length === 0) return;
    const db = await this.db;
    const stores = [...new Set(batch.map((op) => op.store))];
    // Strict durability: the batch is on disk when the promise resolves (crypto state must not be lost).
    const tx = db.transaction(stores, "readwrite", { durability: "strict" });
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("The IndexedDB transaction was aborted"));
    });
    for (const op of batch) {
      const s = tx.objectStore(op.store);
      if (op.type === "put") s.put(op.value, op.key);
      else s.delete(op.key);
    }
    await done;
  }

  async close(): Promise<void> {
    (await this.db).close();
  }
}

/**
 * Storage in an IndexedDB database (default name "katrix"). `indexedDB` and `IDBKeyRange` default
 * to the browser's.
 */
export function indexedDbStorage(opts: { name?: string; indexedDB?: IDBFactoryLike; IDBKeyRange?: IDBKeyRangeLike } = {}): StorageAdapter {
  const g = globalThis as unknown as { indexedDB?: IDBFactoryLike; IDBKeyRange?: IDBKeyRangeLike };
  const factory = opts.indexedDB ?? g.indexedDB;
  const keyRange = opts.IDBKeyRange ?? g.IDBKeyRange;
  if (!factory || !keyRange) throw new Error("IndexedDB is not available here");
  return new IndexedDbStorage(factory, keyRange, opts.name ?? "katrix");
}
