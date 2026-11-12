// src/storage/adapter.ts
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
const STORES = [
	"account",
	"olm_sessions",
	"inbound_group_sessions",
	"outbound_group_sessions",
	"megolm_indices",
	"devices",
	"sync",
	"rooms",
	"room_state",
	"room_timeline",
	"client"
];
export { STORES };

//# sourceMappingURL=adapter.js.map