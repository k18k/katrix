import { StorageAdapter } from "../storage/adapter.js";
/**
 * A StorageAdapter on IndexedDB, for browsers: one object store per client store, one readwrite
 * transaction per batch (all or nothing; IndexedDB aborts the whole transaction on any error).
 * Values are the strings the client writes.
 *
 * One client per database: two tabs on the same database would overwrite each other's crypto
 * state (see StorageAdapter); give each account its own `name`, and keep one tab active (Web
 * Locks) or one database per tab.
 */
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
  objectStoreNames: {
    contains(name: string): boolean;
  };
  createObjectStore(name: string): unknown;
  transaction(stores: string[], mode: "readonly" | "readwrite", options?: {
    durability?: "strict" | "relaxed" | "default";
  }): IDBTransactionLike;
  close(): void;
}
export interface IDBFactoryLike {
  open(name: string, version: number): IDBOpenRequestLike;
}
export interface IDBKeyRangeLike {
  bound(lower: string, upper: string, lowerOpen?: boolean, upperOpen?: boolean): unknown;
}
/**
 * Storage in an IndexedDB database (default name "katrix"). `indexedDB` and `IDBKeyRange` default
 * to the browser's.
 */
export declare function indexedDbStorage(opts?: {
  name?: string;
  indexedDB?: IDBFactoryLike;
  IDBKeyRange?: IDBKeyRangeLike;
}): StorageAdapter;
export {};
//# sourceMappingURL=indexeddb.d.ts.map