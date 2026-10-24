/**
 * Level 3: durable state (crypto sessions and keys, the sync token, the room cache) behind a small
 * key-value interface that IndexedDB, SQLite and MMKV can all implement.
 *
 * Atomicity: every change the client makes goes through `write`, as one batch that must be
 * applied all or nothing. The client never holds a transaction open across its own awaits: it
 * reads, computes, and hands over the finished batch. That is what makes the interface work on
 * IndexedDB (whose transactions commit by themselves as soon as the code awaits anything other
 * than a request of that transaction), and it keeps SQLite transactions short.
 *
 * - IndexedDB: one object store per name in STORES, one readwrite transaction per batch.
 * - SQLite: one table (store, key, value), BEGIN … COMMIT per batch.
 * - MMKV (no multi-key transactions): write the batch as one journal entry, apply it, delete the
 *   journal; on open, re-apply a journal that is still there. Batches are idempotent (puts and
 *   deletes of whole values), so applying one twice is harmless.
 *
 * One client instance is the only writer of its storage. Two instances on the same storage (two
 * browser tabs, two processes) would overwrite each other's crypto state; an app that can open
 * several must lock across them (for example with Web Locks) or give each its own storage.
 */

/** The stores the client uses; an IndexedDB adapter creates them up front. */
export const STORES = [
  /** The Olm account, the device's identity. */
  "account",
  /** Olm sessions, by sender Curve25519 key and session ID. */
  "olm_sessions",
  /** Megolm sessions we received, by room and session ID. */
  "inbound_group_sessions",
  /** The Megolm session we send with, per room. */
  "outbound_group_sessions",
  /** Message indices already decrypted per Megolm session: replay detection across restarts. */
  "megolm_indices",
  /** Other users' devices and their keys, and which users are tracked. */
  "devices",
  /** The sync token and other sync state. */
  "sync",
  /** Room summaries, state and the recent timeline. */
  "rooms",
  "room_state",
  "room_timeline",
  /** Account data and other small client state. */
  "client",
] as const;

export type StoreName = (typeof STORES)[number];

export type WriteOp =
  | { readonly type: "put"; readonly store: StoreName; readonly key: string; readonly value: string }
  | { readonly type: "delete"; readonly store: StoreName; readonly key: string };

export interface StorageAdapter {
  get(store: StoreName, key: string): Promise<string | undefined>;
  /** Entries whose key starts with `prefix` (all with ""), sorted by key. */
  list(store: StoreName, prefix: string): Promise<Array<[key: string, value: string]>>;
  /** Apply every operation, in order, atomically. A rejected promise means none was applied. */
  write(batch: readonly WriteOp[]): Promise<void>;
  close?(): Promise<void>;
}
