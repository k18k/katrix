import type { BatchQuery, DatabaseAdapter, FindManyOptions, Row, WhereClause } from "#storage/types.ts";
import { readBatch } from "#storage/batch.ts";

/**
 * A read of `trackedReads`: from a value cache (`cached`), skipped as empty when a stream log says
 * nothing changed after a position (`unlessChanged`), or else from the database.
 */
export interface TrackedRead {
  query: BatchQuery;
  cached?: { name: ValueName; key: string };
  unlessChanged?: { log: StreamLogName; key: string; after: number };
}

/** Rows kept in a cache are shared between requests: freeze them, so a change fails loudly. */
export function freeze<T>(value: T): T {
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
export async function trackedReads(db: DatabaseAdapter, tracker: ChangeTracker | null, reads: TrackedRead[]): Promise<Row[][]> {
  if (!tracker)
    return readBatch(
      db,
      reads.map((r) => r.query),
    );
  const out: Row[][] = [];
  const pending: number[] = [];
  reads.forEach((read, i) => {
    const skip = read.unlessChanged;
    if (skip && !tracker.logs[skip.log].changedAfter(skip.key, skip.after)) out[i] = [];
    else if (read.cached && (out[i] = tracker.values[read.cached.name].peek(read.cached.key)) !== undefined) return;
    else pending.push(i);
  });
  if (!pending.length) return out;
  const readAt = tracker.now();
  const rows = await readBatch(
    db,
    pending.map((i) => reads[i].query),
  );
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
 * https://github.com/k18k/matrix-nodejs-homeserver/issues/51: most of a `/sync` build asked the
 * database whether something had changed since the token (to-device messages, presence, account
 * data, the user's rooms) and almost always found nothing. Every write passes through the adapter
 * returned by `ChangeTracker.wrap`, which notes, per key, the stream position (or, for cached
 * values, the write) at which it last changed, so `/sync` knows without asking.
 *
 * It is only used without a cluster adapter: another instance's writes would not pass through it.
 * Memory is bounded: each log keeps its most recently changed keys, and forgetting a key raises
 * the log's floor, at or below which every key counts as changed (and the database is asked).
 */
export class ChangeLog {
  private latest = new Map<string, number>();
  private floor: number;
  private max: number;

  constructor(max: number, floor = 0) {
    this.max = max;
    this.floor = floor;
  }

  /** `key` changed at `pos`. */
  record(key: string, pos: number): void {
    const previous = this.latest.get(key);
    this.latest.delete(key);
    this.latest.set(key, previous === undefined ? pos : Math.max(previous, pos));
    if (this.latest.size > this.max) {
      const [oldest, at] = this.latest.entries().next().value!;
      this.latest.delete(oldest);
      if (at > this.floor) this.floor = at;
    }
  }

  /** Every key may have changed at or below `pos` (for writes whose keys are not known). */
  raiseFloor(pos: number): void {
    if (pos > this.floor) this.floor = pos;
  }

  /** Set the floor (also lower it: from "nothing is known" to a starting position). */
  setFloor(pos: number): void {
    this.floor = pos;
  }

  /** Whether `key` may have changed after `pos`; false only when it is known not to have. */
  changedAfter(key: string, pos: number): boolean {
    return pos < this.floor || (this.latest.get(key) ?? Number.NEGATIVE_INFINITY) > pos;
  }

  /** The keys among `keys` that may have changed after `pos`. */
  filterChanged(keys: Iterable<string>, pos: number): string[] {
    const out: string[] = [];
    for (const k of keys) if (this.changedAfter(k, pos)) out.push(k);
    return out;
  }
}

/**
 * Values read from the database, kept until a write changes their key. A value is only kept if
 * no write to its key started while it was being read; in a transaction, the keys are marked
 * again once it commits, so a value read before the commit is not kept either.
 */
export class ValueCache<V> {
  private values = new Map<string, { value: V; readAt: number }>();
  private writes: ChangeLog;
  private clock: () => number;
  private max: number;

  constructor(max: number, clock: () => number) {
    this.max = max;
    this.clock = clock;
    this.writes = new ChangeLog(max * 2);
  }

  /** A write to `key` (or, without a key, to any) has started or finished at `tick`. */
  written(key: string | null, tick: number): void {
    if (key === null) {
      this.writes.raiseFloor(tick);
      this.values.clear();
    } else {
      this.writes.record(key, tick);
      this.values.delete(key);
    }
  }

  /** The kept value of `key`, if there is one and no write has changed it since it was read. */
  peek(key: string): V | undefined {
    const hit = this.values.get(key);
    if (!hit) return undefined;
    if (this.writes.changedAfter(key, hit.readAt)) {
      this.values.delete(key);
      return undefined;
    }
    this.values.delete(key);
    this.values.set(key, hit);
    return hit.value;
  }

  /**
   * Keep `value`, read by a read that began at `readAt` (the clock then): unless a write to `key`
   * began since, which may or may not be in `value`.
   */
  store(key: string, value: V, readAt: number): void {
    if (this.writes.changedAfter(key, readAt)) return;
    this.values.delete(key);
    this.values.set(key, { value, readAt });
    if (this.values.size > this.max) this.values.delete(this.values.keys().next().value!);
  }

  async get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.peek(key);
    if (hit !== undefined) return hit;
    const readAt = this.clock();
    const value = await load();
    this.store(key, value, readAt);
    return value;
  }
}

/** Stream logs: keys that changed at a stream position. */
export type StreamLogName =
  | "toDevice"
  | "presence"
  | "deviceLists"
  | "accountData"
  | "roomEvents"
  | "roomReceipts"
  | "roomMembers"
  | "roomPartialState";
/** Value caches: values kept until their key is written. */
export type ValueName =
  | "userMemberships"
  | "ignoredUsers"
  | "oneTimeKeys"
  | "fallbackKeys"
  | "presenceRow"
  | "readReceipts"
  | "unreadCounts";

const LOG_SIZE = 100_000;
const CACHE_SIZE = 50_000;

/** What a write to a model changes: which logs and caches, under which key. */
interface Rule {
  stream?: StreamLogName;
  value?: ValueName;
  /** The key, from the row's (or the where clause's) fields; null when they are not all there. */
  key: (fields: Record<string, unknown>) => string | null;
  /** The field holding the change's stream position (default `stream`). */
  pos?: string;
}

const join = (...parts: unknown[]) => (parts.every((p) => typeof p === "string") ? parts.join("|") : null);
const GLOBAL = () => "*";

const RULES: Record<string, Rule[]> = {
  to_device: [{ stream: "toDevice", key: (f) => join(f.user_id, f.device_id) }],
  presence: [
    { stream: "presence", key: GLOBAL },
    { value: "presenceRow", key: (f) => join(f.user_id) },
  ],
  device_list_changes: [{ stream: "deviceLists", key: GLOBAL }],
  account_data: [
    { stream: "accountData", key: (f) => join(f.user_id) },
    { value: "ignoredUsers", key: (f) => join(f.user_id) },
  ],
  events: [{ stream: "roomEvents", key: (f) => join(f.room_id) }],
  receipts: [
    { stream: "roomReceipts", key: (f) => join(f.room_id) },
    { value: "readReceipts", key: (f) => join(f.room_id, f.user_id) },
    { value: "unreadCounts", key: (f) => join(f.user_id, f.room_id) },
  ],
  memberships: [
    { stream: "roomMembers", key: (f) => join(f.room_id) },
    { value: "userMemberships", key: (f) => join(f.user_id) },
  ],
  partial_state_rooms: [{ stream: "roomPartialState", key: (f) => join(f.room_id), pos: "completed_stream" }],
  notifications: [{ value: "unreadCounts", key: (f) => join(f.user_id, f.room_id) }],
  one_time_keys: [{ value: "oneTimeKeys", key: (f) => join(f.user_id, f.device_id) }],
  fallback_keys: [{ value: "fallbackKeys", key: (f) => join(f.user_id, f.device_id) }],
};

/** The fields a where clause pins to one value. */
function pinned(where: WhereClause[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const w of where) if ((w.operator ?? "eq") === "eq") out[w.field] = w.value;
  return out;
}

export class ChangeTracker {
  readonly logs: Record<StreamLogName, ChangeLog>;
  readonly values: Record<ValueName, ValueCache<any>>;
  private tick = 0;

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
      roomPartialState: log(),
    };
    const clock = () => this.tick;
    const cache = () => new ValueCache<any>(CACHE_SIZE, clock);
    this.values = {
      userMemberships: cache(),
      ignoredUsers: cache(),
      oneTimeKeys: cache(),
      fallbackKeys: cache(),
      presenceRow: cache(),
      readReceipts: cache(),
      unreadCounts: cache(),
    };
  }

  /**
   * Begin answering for changes after `position`. Until then, every key counts as changed. Every
   * write after the adapter was wrapped is noted, so the logs know all changes after `position`
   * if it was read after wrapping.
   */
  start(position: number): void {
    // The floor was +∞ (nothing known); now it is the position up to which writes predate us.
    for (const log of Object.values(this.logs)) log.setFloor(position);
  }

  /** The clock to pass to `ValueCache.store` for a read that begins now. */
  now(): number {
    return this.tick;
  }

  /** Note a write to `model`: `rows` written, or rows matching `where` changed or deleted. */
  private note(model: string, rows: Row[] | null, where: WhereClause[] | null, data?: Row): string[] {
    const rules = RULES[model];
    if (!rules) return [];
    const tick = ++this.tick;
    const touched: string[] = [];
    const sources: Record<string, unknown>[] = rows ?? [{ ...pinned(where ?? []), ...data }];
    for (const fields of sources) {
      for (const rule of rules) {
        const key = rule.key(fields);
        if (rule.value) {
          this.values[rule.value].written(key, tick);
          if (key !== null) touched.push(`${rule.value}\0${key}`);
        }
        if (rule.stream) {
          const pos = fields[rule.pos ?? "stream"];
          // A write without a position (a delete, an update of other fields) is no new change.
          if (typeof pos !== "number") continue;
          if (key === null) this.logs[rule.stream].raiseFloor(pos);
          else this.logs[rule.stream].record(key, pos);
        }
      }
    }
    return touched;
  }

  /** Mark cached values written again (after a transaction committed). */
  private rewritten(touched: string[]): void {
    const tick = ++this.tick;
    for (const t of touched) {
      const [name, key] = t.split("\0") as [ValueName, string];
      this.values[name].written(key, tick);
    }
  }

  /** An adapter that notes every write before passing it on to `db`. */
  wrap(db: DatabaseAdapter): DatabaseAdapter {
    return this.wrapWith(db, null);
  }

  private wrapWith(db: DatabaseAdapter, inTx: string[] | null): DatabaseAdapter {
    // Outside a transaction a write is marked before and after it runs; inside, the keys are kept
    // and marked again after the commit.
    const around = async <T>(touched: string[], run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } finally {
        if (inTx) inTx.push(...touched);
        else this.rewritten(touched);
      }
    };
    const adapter: DatabaseAdapter = {
      findMany: (model, opts?: FindManyOptions) => db.findMany(model, opts),
      findOne: (model, where) => db.findOne(model, where),
      ...(db.findManyBatch ? { findManyBatch: (queries, options) => db.findManyBatch!(queries, options) } : {}),
      create: (model, data) => around(this.note(model, [data], null), () => db.create(model, data)),
      upsert: (model, data) => around(this.note(model, [data], null), () => db.upsert(model, data)),
      ...(db.upsertMany
        ? { upsertMany: (model: string, rows: Row[]) => around(this.note(model, rows, null), () => db.upsertMany!(model, rows)) }
        : {}),
      update: (model, where, data) => around(this.note(model, null, where, data), () => db.update(model, where, data)),
      delete: (model, where) => around(this.note(model, null, where), () => db.delete(model, where)),
      max: (model, field) => db.max(model, field),
      ...(db.migrate ? { migrate: (schema) => db.migrate!(schema) } : {}),
    };
    if (db.transaction) {
      adapter.transaction = async <T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> => {
        if (inTx) return db.transaction!((tx) => fn(this.wrapWith(tx, inTx)));
        const touched: string[] = [];
        try {
          return await db.transaction!((tx) => fn(this.wrapWith(tx, touched)));
        } finally {
          this.rewritten(touched);
        }
      };
    }
    return adapter;
  }
}
