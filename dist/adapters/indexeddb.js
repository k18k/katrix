import { STORES } from "../storage/adapter.js";
// src/adapters/indexeddb.ts
function request(r) {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}
const VERSION = 1;
var IndexedDbStorage = class {
	db;
	keyRange;
	constructor(factory, keyRange, name) {
		this.keyRange = keyRange;
		this.db = new Promise((resolve, reject) => {
			const open = factory.open(name, VERSION);
			open.onupgradeneeded = () => {
				for (const store of STORES) if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store);
			};
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
			open.onblocked = () => reject(/* @__PURE__ */ new Error("The database is open elsewhere with an older version"));
		});
	}
	async get(store, key) {
		const value = await request((await this.db).transaction([store], "readonly").objectStore(store).get(key));
		return typeof value === "string" ? value : void 0;
	}
	async list(store, prefix) {
		const s = (await this.db).transaction([store], "readonly").objectStore(store);
		const range = this.keyRange.bound(prefix, `${prefix}￿`, false, false);
		const [keys, values] = await Promise.all([request(s.getAllKeys(range)), request(s.getAll(range))]);
		return keys.map((k, i) => [String(k), String(values[i])]);
	}
	async write(batch) {
		if (batch.length === 0) return;
		const db = await this.db;
		const stores = [...new Set(batch.map((op) => op.store))];
		const tx = db.transaction(stores, "readwrite", { durability: "strict" });
		const done = new Promise((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error ?? /* @__PURE__ */ new Error("The IndexedDB transaction was aborted"));
		});
		for (const op of batch) {
			const s = tx.objectStore(op.store);
			if (op.type === "put") s.put(op.value, op.key);
			else s.delete(op.key);
		}
		await done;
	}
	async close() {
		(await this.db).close();
	}
};
/**
* Storage in an IndexedDB database (default name "katrix"). `indexedDB` and `IDBKeyRange` default
* to the browser's.
*/
function indexedDbStorage(opts = {}) {
	const g = globalThis;
	const factory = opts.indexedDB ?? g.indexedDB;
	const keyRange = opts.IDBKeyRange ?? g.IDBKeyRange;
	if (!factory || !keyRange) throw new Error("IndexedDB is not available here");
	return new IndexedDbStorage(factory, keyRange, opts.name ?? "katrix");
}
export { indexedDbStorage };

//# sourceMappingURL=indexeddb.js.map