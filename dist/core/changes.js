import { readBatch } from "../storage/batch.js";
// src/core/changes.ts
/** Rows kept in a cache are shared between requests: freeze them, so a change fails loudly. */
function freeze(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value)) freeze(v);
	}
	return value;
}
/**
* Run `reads` like `readBatch`, but answer from the change tracker what it can (#51); the others
* still go to the database together. Without a tracker (in a cluster), all go to the database.
*/
async function trackedReads(db, tracker, reads) {
	if (!tracker) return readBatch(db, reads.map((r) => r.query));
	const out = [];
	const pending = [];
	reads.forEach((read, i) => {
		const skip = read.unlessChanged;
		if (skip && !tracker.logs[skip.log].changedAfter(skip.key, skip.after)) out[i] = [];
		else if (read.cached && (out[i] = tracker.values[read.cached.name].peek(read.cached.key)) !== void 0) return;
		else pending.push(i);
	});
	if (!pending.length) return out;
	const readAt = tracker.now();
	const rows = await readBatch(db, pending.map((i) => reads[i].query));
	pending.forEach((i, j) => {
		out[i] = rows[j];
		const cached = reads[i].cached;
		if (cached) tracker.values[cached.name].store(cached.key, freeze(rows[j]), readAt);
	});
	return out;
}
/**
* Where keys last changed, for a homeserver that is the only instance on its database.
*
* https://github.com/k18k/katrix/issues/51: most of a `/sync` build asked the
* database whether something had changed since the token (to-device messages, presence, account
* data, the user's rooms) and almost always found nothing. Every write passes through the adapter
* returned by `ChangeTracker.wrap`, which notes, per key, the stream position (or, for cached
* values, the write) at which it last changed, so `/sync` knows without asking.
*
* It is only used without a cluster adapter: another instance's writes would not pass through it.
* Memory is bounded: each log keeps its most recently changed keys, and forgetting a key raises
* the log's floor, at or below which every key counts as changed (and the database is asked).
*/
var ChangeLog = class {
	latest = /* @__PURE__ */ new Map();
	floor;
	max;
	constructor(max, floor = 0) {
		this.max = max;
		this.floor = floor;
	}
	/** `key` changed at `pos`. */
	record(key, pos) {
		const previous = this.latest.get(key);
		this.latest.delete(key);
		this.latest.set(key, previous === void 0 ? pos : Math.max(previous, pos));
		if (this.latest.size > this.max) {
			const [oldest, at] = this.latest.entries().next().value;
			this.latest.delete(oldest);
			if (at > this.floor) this.floor = at;
		}
	}
	/** Every key may have changed at or below `pos` (for writes whose keys are not known). */
	raiseFloor(pos) {
		if (pos > this.floor) this.floor = pos;
	}
	/** Set the floor (also lower it: from "nothing is known" to a starting position). */
	setFloor(pos) {
		this.floor = pos;
	}
	/** Whether `key` may have changed after `pos`; false only when it is known not to have. */
	changedAfter(key, pos) {
		return pos < this.floor || (this.latest.get(key) ?? Number.NEGATIVE_INFINITY) > pos;
	}
	/** The keys among `keys` that may have changed after `pos`. */
	/** Whether the log knows every change after `pos`, so that a key it names did change. */
	knowsAfter(pos) {
		return pos >= this.floor;
	}
	filterChanged(keys, pos) {
		const out = [];
		for (const k of keys) if (this.changedAfter(k, pos)) out.push(k);
		return out;
	}
};
/**
* Values read from the database, kept until a write changes their key. A value is only kept if
* no write to its key started while it was being read; in a transaction, the keys are marked
* again once it commits, so a value read before the commit is not kept either.
*/
var ValueCache = class {
	values = /* @__PURE__ */ new Map();
	writes;
	clock;
	max;
	constructor(max, clock) {
		this.max = max;
		this.clock = clock;
		this.writes = new ChangeLog(max * 2);
	}
	/** A write to `key` (or, without a key, to any) has started or finished at `tick`. */
	written(key, tick) {
		if (key === null) {
			this.writes.raiseFloor(tick);
			this.values.clear();
		} else {
			this.writes.record(key, tick);
			this.values.delete(key);
		}
	}
	/** The kept value of `key`, if there is one and no write has changed it since it was read. */
	peek(key) {
		const hit = this.values.get(key);
		if (!hit) return void 0;
		if (this.writes.changedAfter(key, hit.readAt)) {
			this.values.delete(key);
			return;
		}
		this.values.delete(key);
		this.values.set(key, hit);
		return hit.value;
	}
	/**
	* Keep `value`, read by a read that began at `readAt` (the clock then): unless a write to `key`
	* began since, which may or may not be in `value`.
	*/
	store(key, value, readAt) {
		if (this.writes.changedAfter(key, readAt)) return;
		this.values.delete(key);
		this.values.set(key, {
			value,
			readAt
		});
		if (this.values.size > this.max) this.values.delete(this.values.keys().next().value);
	}
	async get(key, load) {
		const hit = this.peek(key);
		if (hit !== void 0) return hit;
		const readAt = this.clock();
		const value = await load();
		this.store(key, value, readAt);
		return value;
	}
};
const LOG_SIZE = 1e5;
const CACHE_SIZE = 5e4;
const join = (...parts) => parts.every((p) => typeof p === "string") ? parts.join("|") : null;
const GLOBAL = () => "*";
const RULES = {
	to_device: [{
		stream: "toDevice",
		key: (f) => join(f.user_id, f.device_id)
	}],
	presence: [
		{
			stream: "presence",
			key: GLOBAL
		},
		{
			stream: "presence",
			key: (f) => join(f.user_id)
		},
		{
			value: "presenceRow",
			key: (f) => join(f.user_id)
		}
	],
	device_list_changes: [{
		stream: "deviceLists",
		key: GLOBAL
	}],
	account_data: [{
		stream: "accountData",
		key: (f) => join(f.user_id)
	}, {
		value: "ignoredUsers",
		key: (f) => join(f.user_id)
	}],
	events: [{
		stream: "roomEvents",
		key: (f) => join(f.room_id)
	}],
	receipts: [
		{
			stream: "roomReceipts",
			key: (f) => join(f.room_id)
		},
		{
			value: "readReceipts",
			key: (f) => join(f.room_id, f.user_id)
		},
		{
			value: "unreadCounts",
			key: (f) => join(f.user_id, f.room_id)
		}
	],
	memberships: [{
		stream: "roomMembers",
		key: (f) => join(f.room_id)
	}, {
		value: "userMemberships",
		key: (f) => join(f.user_id)
	}],
	partial_state_rooms: [{
		stream: "roomPartialState",
		key: (f) => join(f.room_id),
		pos: "completed_stream"
	}],
	notifications: [{
		value: "unreadCounts",
		key: (f) => join(f.user_id, f.room_id)
	}],
	one_time_keys: [{
		value: "oneTimeKeys",
		key: (f) => join(f.user_id, f.device_id)
	}],
	fallback_keys: [{
		value: "fallbackKeys",
		key: (f) => join(f.user_id, f.device_id)
	}]
};
/** The fields a where clause pins to one value. */
function pinned(where) {
	const out = {};
	for (const w of where) if ((w.operator ?? "eq") === "eq") out[w.field] = w.value;
	return out;
}
var ChangeTracker = class {
	logs;
	values;
	tick = 0;
	constructor() {
		const log = () => new ChangeLog(LOG_SIZE, Number.POSITIVE_INFINITY);
		this.logs = {
			toDevice: log(),
			presence: log(),
			deviceLists: log(),
			accountData: log(),
			roomEvents: log(),
			roomReceipts: log(),
			roomMembers: log(),
			roomPartialState: log()
		};
		const clock = () => this.tick;
		const cache = () => new ValueCache(CACHE_SIZE, clock);
		this.values = {
			userMemberships: cache(),
			ignoredUsers: cache(),
			oneTimeKeys: cache(),
			fallbackKeys: cache(),
			presenceRow: cache(),
			readReceipts: cache(),
			unreadCounts: cache()
		};
	}
	/**
	* Begin answering for changes after `position`. Until then, every key counts as changed. Every
	* write after the adapter was wrapped is noted, so the logs know all changes after `position`
	* if it was read after wrapping.
	*/
	start(position) {
		for (const log of Object.values(this.logs)) log.setFloor(position);
	}
	/** The clock to pass to `ValueCache.store` for a read that begins now. */
	now() {
		return this.tick;
	}
	/** Note a write to `model`: `rows` written, or rows matching `where` changed or deleted. */
	note(model, rows, where, data) {
		const rules = RULES[model];
		if (!rules) return [];
		const tick = ++this.tick;
		const touched = [];
		const sources = rows ?? [{
			...pinned(where ?? []),
			...data
		}];
		for (const fields of sources) for (const rule of rules) {
			const key = rule.key(fields);
			if (rule.value) {
				this.values[rule.value].written(key, tick);
				if (key !== null) touched.push(`${rule.value}\0${key}`);
			}
			if (rule.stream) {
				const pos = fields[rule.pos ?? "stream"];
				if (typeof pos !== "number") continue;
				if (key === null) this.logs[rule.stream].raiseFloor(pos);
				else this.logs[rule.stream].record(key, pos);
			}
		}
		return touched;
	}
	/** Mark cached values written again (after a transaction committed). */
	rewritten(touched) {
		const tick = ++this.tick;
		for (const t of touched) {
			const [name, key] = t.split("\0");
			this.values[name].written(key, tick);
		}
	}
	/** An adapter that notes every write before passing it on to `db`. */
	wrap(db) {
		return this.wrapWith(db, null);
	}
	wrapWith(db, inTx) {
		const around = async (touched, run) => {
			try {
				return await run();
			} finally {
				if (inTx) inTx.push(...touched);
				else this.rewritten(touched);
			}
		};
		const adapter = {
			findMany: (model, opts) => db.findMany(model, opts),
			findOne: (model, where) => db.findOne(model, where),
			...db.findManyBatch ? { findManyBatch: (queries, options) => db.findManyBatch(queries, options) } : {},
			create: (model, data) => around(this.note(model, [data], null), () => db.create(model, data)),
			upsert: (model, data) => around(this.note(model, [data], null), () => db.upsert(model, data)),
			...db.upsertMany ? { upsertMany: (model, rows) => around(this.note(model, rows, null), () => db.upsertMany(model, rows)) } : {},
			update: (model, where, data) => around(this.note(model, null, where, data), () => db.update(model, where, data)),
			delete: (model, where) => around(this.note(model, null, where), () => db.delete(model, where)),
			max: (model, field) => db.max(model, field),
			...db.migrate ? { migrate: (schema) => db.migrate(schema) } : {}
		};
		if (db.transaction) adapter.transaction = async (fn) => {
			if (inTx) return db.transaction((tx) => fn(this.wrapWith(tx, inTx)));
			const touched = [];
			try {
				return await db.transaction((tx) => fn(this.wrapWith(tx, touched)));
			} finally {
				this.rewritten(touched);
			}
		};
		return adapter;
	}
};
export { ChangeLog, ChangeTracker, ValueCache, freeze, trackedReads };

//# sourceMappingURL=changes.js.map