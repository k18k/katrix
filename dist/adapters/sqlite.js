import { Mutex } from "../util/mutex.js";
// src/adapters/sqlite.ts
/** Above every character a key can continue with (keys compare as UTF-8 bytes, that is, by code point). */
const PREFIX_END = "􏿿";
var SqliteStorage = class {
	db;
	table;
	mutex = new Mutex();
	ready;
	constructor(db, table) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("Invalid table name");
		this.db = db;
		this.table = table;
	}
	init() {
		this.ready ??= this.mutex.run(async () => {
			await this.db.run(`CREATE TABLE IF NOT EXISTS ${this.table} (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key)) WITHOUT ROWID`, []);
		});
		return this.ready;
	}
	async get(store, key) {
		await this.init();
		return this.mutex.run(async () => {
			const value = (await this.db.all(`SELECT value FROM ${this.table} WHERE store = ? AND key = ?`, [store, key]))[0]?.value;
			return typeof value === "string" ? value : void 0;
		});
	}
	async list(store, prefix) {
		await this.init();
		return this.mutex.run(async () => {
			return (await this.db.all(`SELECT key, value FROM ${this.table} WHERE store = ? AND key >= ? AND key < ? ORDER BY key`, [
				store,
				prefix,
				prefix + PREFIX_END
			])).map((r) => [String(r.key), String(r.value)]);
		});
	}
	async write(batch) {
		if (batch.length === 0) return;
		await this.init();
		await this.mutex.run(async () => {
			await this.db.run("BEGIN IMMEDIATE", []);
			try {
				for (const op of batch) if (op.type === "put") await this.db.run(`INSERT INTO ${this.table} (store, key, value) VALUES (?, ?, ?) ON CONFLICT (store, key) DO UPDATE SET value = excluded.value`, [
					op.store,
					op.key,
					op.value
				]);
				else await this.db.run(`DELETE FROM ${this.table} WHERE store = ? AND key = ?`, [op.store, op.key]);
				await this.db.run("COMMIT", []);
			} catch (e) {
				try {
					await this.db.run("ROLLBACK", []);
				} catch {}
				throw e;
			}
		});
	}
};
/** Storage in an SQLite database (the table is created on first use; `table` defaults to "katrix"). */
function sqliteStorage(db, opts = {}) {
	return new SqliteStorage(db, opts.table ?? "katrix");
}
export { sqliteStorage };

//# sourceMappingURL=sqlite.js.map