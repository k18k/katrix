import { localCluster, underLease } from "../core/cluster.js";
import { ignorePgError } from "../storage/sql.js";
import { randomUUID } from "node:crypto";
// src/adapters/cluster.ts
/** Per-process queue so each instance holds at most one remote lock per key. */
function localQueue() {
	const tails = /* @__PURE__ */ new Map();
	return async (key, fn) => {
		const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
		const settled = run.catch(() => {});
		tails.set(key, settled);
		try {
			return await run;
		} finally {
			if (tails.get(key) === settled) tails.delete(key);
		}
	};
}
const PG_CHANNEL = "matrix_cluster";
/** Internal pub/sub channel announcing released locks. */
const RELEASED = "__lock_released";
/** How long a lock lease lasts without renewal (it is renewed every third of that while held). */
const LOCK_TTL_MS = 3e4;
const MAX_NOTIFY_PAYLOAD = 7e3;
/**
* Cluster adapter backed by PostgreSQL (`pg` Pool): sequences, leased locks,
* LISTEN/NOTIFY pub/sub and an expiring key-value table. Lets several homeserver
* instances share one database.
*/
function postgresCluster(pool, options = {}) {
	const seq = `"${options.tablePrefix ?? ""}cluster_sequences"`;
	const kv = `"${options.tablePrefix ?? ""}cluster_kv"`;
	const handlers = /* @__PURE__ */ new Map();
	const queue = localQueue();
	const waiting = /* @__PURE__ */ new Map();
	const releasedOrAfter = (lockKey, ms) => new Promise((resolve) => {
		let set = waiting.get(lockKey);
		if (!set) waiting.set(lockKey, set = /* @__PURE__ */ new Set());
		const wake = () => {
			clearTimeout(timer);
			set.delete(wake);
			if (set.size === 0 && waiting.get(lockKey) === set) waiting.delete(lockKey);
			resolve();
		};
		const timer = setTimeout(wake, ms);
		set.add(wake);
	});
	handlers.set(RELEASED, /* @__PURE__ */ new Set([(lockKey) => [...waiting.get(lockKey) ?? []].forEach((wake) => wake())]));
	let listener = null;
	pool.on?.("error", ignorePgError);
	let cleanup = null;
	let closed = false;
	const onNotification = (msg) => {
		if (msg.channel !== PG_CHANNEL || !msg.payload) return;
		(async () => {
			let parsed = JSON.parse(msg.payload);
			if (parsed.ref) {
				const res = await pool.query(`SELECT value FROM ${kv} WHERE key = $1`, [parsed.ref]);
				if (!res.rows[0]) return;
				parsed = JSON.parse(res.rows[0].value);
			}
			for (const h of handlers.get(parsed.channel) ?? []) h(parsed.message);
		})().catch(() => {});
	};
	const listen = async () => {
		const client = await pool.connect();
		const lost = () => {
			if (listener !== client) return;
			listener = null;
			client.release(true);
			if (!closed) reconnect(500);
		};
		client.on("error", lost);
		client.on("end", lost);
		client.on("notification", onNotification);
		try {
			await client.query(`LISTEN ${PG_CHANNEL}`);
		} catch (err) {
			client.release(true);
			throw err;
		}
		if (closed) {
			client.release(true);
			return;
		}
		listener = client;
	};
	const reconnect = (delay) => {
		setTimeout(() => {
			if (closed) return;
			listen().then(() => {
				if (!closed) [...handlers.get("__cluster_resync") ?? []].forEach((h) => h(void 0));
			}, () => reconnect(Math.min(delay * 2, 3e4)));
		}, delay).unref?.();
	};
	const ready = (async () => {
		const setup = await pool.connect();
		try {
			await setup.query("BEGIN");
			await setup.query("SELECT pg_advisory_xact_lock(hashtextextended('matrix_cluster_setup', 0))");
			await setup.query(`CREATE TABLE IF NOT EXISTS ${seq} (name TEXT PRIMARY KEY, value BIGINT NOT NULL)`);
			await setup.query(`CREATE TABLE IF NOT EXISTS ${kv} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at BIGINT)`);
			await setup.query("COMMIT");
		} catch (err) {
			await setup.query("ROLLBACK").catch(() => {});
			throw err;
		} finally {
			setup.release();
		}
		await listen();
		cleanup = setInterval(() => void pool.query(`DELETE FROM ${kv} WHERE expires_at IS NOT NULL AND expires_at < $1`, [Date.now()]).catch(() => {}), 6e4);
		cleanup.unref?.();
	})();
	ready.catch(() => {});
	const q = async (text, values) => {
		await ready;
		return pool.query(text, values);
	};
	return {
		async nextId(name) {
			const res = await q(`INSERT INTO ${seq} (name, value) VALUES ($1, 1) ON CONFLICT (name) DO UPDATE SET value = ${seq}.value + 1 RETURNING value`, [name]);
			return Number(res.rows[0].value);
		},
		async currentId(name) {
			const res = await q(`SELECT value FROM ${seq} WHERE name = $1`, [name]);
			return res.rows[0] ? Number(res.rows[0].value) : 0;
		},
		async advance(name, value) {
			await q(`INSERT INTO ${seq} (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = GREATEST(${seq}.value, EXCLUDED.value)`, [name, value]);
		},
		lock(key, fn) {
			return queue(key, async () => {
				await ready;
				const lockKey = `lock:${key}`;
				const token = randomUUID();
				const acquire = async () => {
					const now = Date.now();
					return ((await pool.query(`INSERT INTO ${kv} (key, value, expires_at) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
             WHERE ${kv}.expires_at IS NOT NULL AND ${kv}.expires_at <= $4 RETURNING key`, [
						lockKey,
						token,
						now + LOCK_TTL_MS,
						now
					])).rowCount ?? 0) > 0;
				};
				for (let delay = 5; !await acquire(); delay = Math.min(delay * 2, 200)) await releasedOrAfter(lockKey, delay);
				let lost = null;
				let renewedAt = Date.now();
				const renew = setInterval(() => {
					const sentAt = Date.now();
					pool.query(`UPDATE ${kv} SET expires_at = $3 WHERE key = $1 AND value = $2`, [
						lockKey,
						token,
						sentAt + LOCK_TTL_MS
					]).then((res) => {
						if ((res.rowCount ?? 0) > 0) renewedAt = sentAt;
						else lost ??= /* @__PURE__ */ new Error(`Cluster lock ${key} was lost: another instance took over its lease`);
					}, () => {});
				}, LOCK_TTL_MS / 3);
				const check = () => {
					if (!lost && Date.now() - renewedAt >= LOCK_TTL_MS) lost = /* @__PURE__ */ new Error(`Cluster lock ${key} was lost: its lease could not be renewed`);
					if (lost) throw lost;
				};
				try {
					return await underLease(check, fn);
				} finally {
					clearInterval(renew);
					await pool.query(`WITH released AS (DELETE FROM ${kv} WHERE key = $1 AND value = $2 RETURNING key) SELECT pg_notify($3, $4) FROM released`, [
						lockKey,
						token,
						PG_CHANNEL,
						JSON.stringify({
							channel: RELEASED,
							message: lockKey
						})
					]).catch(() => {});
				}
			});
		},
		async publish(channel, message) {
			let payload = JSON.stringify({
				channel,
				message
			});
			if (payload.length > MAX_NOTIFY_PAYLOAD) {
				const ref = `pubsub:${randomUUID()}`;
				await q(`INSERT INTO ${kv} (key, value, expires_at) VALUES ($1, $2, $3)`, [
					ref,
					payload,
					Date.now() + 6e4
				]);
				payload = JSON.stringify({ ref });
			}
			await q("SELECT pg_notify($1, $2)", [PG_CHANNEL, payload]);
		},
		subscribe(channel, handler) {
			let set = handlers.get(channel);
			if (!set) handlers.set(channel, set = /* @__PURE__ */ new Set());
			set.add(handler);
		},
		async get(key) {
			const res = await q(`SELECT value FROM ${kv} WHERE key = $1 AND (expires_at IS NULL OR expires_at > $2)`, [key, Date.now()]);
			return res.rows[0] ? JSON.parse(res.rows[0].value) : null;
		},
		async set(key, value, ttlMs) {
			await q(`INSERT INTO ${kv} (key, value, expires_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`, [
				key,
				JSON.stringify(value),
				ttlMs ? Date.now() + ttlMs : null
			]);
		},
		async setIfAbsent(key, value, ttlMs) {
			const now = Date.now();
			return ((await q(`INSERT INTO ${kv} (key, value, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
         WHERE ${kv}.expires_at IS NOT NULL AND ${kv}.expires_at <= $4 RETURNING key`, [
				key,
				JSON.stringify(value),
				ttlMs ? now + ttlMs : null,
				now
			])).rowCount ?? 0) > 0;
		},
		async delete(key) {
			await q(`DELETE FROM ${kv} WHERE key = $1`, [key]);
		},
		async entries(prefix) {
			const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
			return (await q(`SELECT key, value FROM ${kv} WHERE key LIKE $1 AND (expires_at IS NULL OR expires_at > $2)`, [`${escaped}%`, Date.now()])).rows.map((r) => [r.key, JSON.parse(r.value)]);
		},
		async close() {
			closed = true;
			if (cleanup) clearInterval(cleanup);
			const l = listener;
			listener = null;
			if (l) {
				await l.query(`UNLISTEN ${PG_CHANNEL}`).catch(() => {});
				l.release();
			}
		}
	};
}
export { localCluster, postgresCluster };

//# sourceMappingURL=cluster.js.map