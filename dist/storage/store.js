import { Mutex } from "../util/mutex.js";
// src/storage/store.ts
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
var Store = class {
	adapter;
	mutex = new Mutex();
	constructor(adapter) {
		this.adapter = adapter;
	}
	/** Read committed state, outside any unit of work. */
	async get(store, key) {
		const raw = await this.adapter.get(store, key);
		return raw === void 0 ? void 0 : JSON.parse(raw);
	}
	async list(store, prefix = "") {
		return (await this.adapter.list(store, prefix)).map(([k, v]) => [k, JSON.parse(v)]);
	}
	/** Run `task` as one unit of work. Its writes are applied atomically after it returns. */
	transaction(task) {
		return this.mutex.run(async () => {
			const tx = new Transaction(this.adapter);
			const result = await task(tx);
			await tx.commit();
			return result;
		});
	}
	close() {
		return this.mutex.run(async () => {
			await this.adapter.close?.();
		});
	}
};
var Transaction = class Transaction {
	adapter;
	/** Pending writes, by store and key: a later write to the same key replaces the earlier one. */
	pending = /* @__PURE__ */ new Map();
	committed = false;
	afterCommit = [];
	constructor(adapter) {
		this.adapter = adapter;
	}
	static id(store, key) {
		return `${store}\u0000${key}`;
	}
	async get(store, key) {
		const op = this.pending.get(Transaction.id(store, key));
		if (op) return op.type === "put" ? JSON.parse(op.value) : void 0;
		const raw = await this.adapter.get(store, key);
		return raw === void 0 ? void 0 : JSON.parse(raw);
	}
	async list(store, prefix = "") {
		const merged = new Map(await this.adapter.list(store, prefix));
		for (const op of this.pending.values()) {
			if (op.store !== store || !op.key.startsWith(prefix)) continue;
			if (op.type === "put") merged.set(op.key, op.value);
			else merged.delete(op.key);
		}
		return [...merged.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([k, v]) => [k, JSON.parse(v)]);
	}
	put(store, key, value) {
		this.assertOpen();
		this.pending.set(Transaction.id(store, key), {
			type: "put",
			store,
			key,
			value: JSON.stringify(value)
		});
	}
	delete(store, key) {
		this.assertOpen();
		this.pending.set(Transaction.id(store, key), {
			type: "delete",
			store,
			key
		});
	}
	/** Run `fn` once the batch is durable (for example, emit events about what was stored). */
	onCommit(fn) {
		this.afterCommit.push(fn);
	}
	assertOpen() {
		if (this.committed) throw new Error("Write after the unit of work was committed");
	}
	async commit() {
		this.assertOpen();
		this.committed = true;
		if (this.pending.size > 0) await this.adapter.write([...this.pending.values()]);
		for (const fn of this.afterCommit) fn();
	}
};
export { Store, Transaction };

//# sourceMappingURL=store.js.map