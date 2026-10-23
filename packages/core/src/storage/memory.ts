import type { DatabaseAdapter, FindManyOptions, Row, Schema, WhereClause } from "./types.ts";

export function matches(row: Row, where: WhereClause[] = []): boolean {
  for (const w of where) {
    const v = row[w.field] ?? null;
    const target = w.value ?? null;
    switch (w.operator ?? "eq") {
      case "eq":
        if (v !== target) return false;
        break;
      case "ne":
        if (v === target) return false;
        break;
      case "lt":
        if (!(v < (target as any))) return false;
        break;
      case "lte":
        if (!(v <= (target as any))) return false;
        break;
      case "gt":
        if (!(v > (target as any))) return false;
        break;
      case "gte":
        if (!(v >= (target as any))) return false;
        break;
      case "in":
        if (!(target as unknown[]).includes(v)) return false;
        break;
    }
  }
  return true;
}

/** In-memory adapter. Data is lost on restart; useful for tests and development. */
export function memoryAdapter(): DatabaseAdapter {
  const tables = new Map<string, Map<string, Row>>();
  const pks = new Map<string, string[]>();

  const table = (model: string) => {
    let t = tables.get(model);
    if (!t) tables.set(model, (t = new Map()));
    return t;
  };
  const keyOf = (model: string, row: Row) => JSON.stringify((pks.get(model) ?? Object.keys(row)).map((k) => row[k]));

  /** Undo log entries: restore `row` (or delete when undefined) at `key`. */
  type Journal = { model: string; key: string; row: Row | undefined }[];

  const build = (journal: Journal | null): DatabaseAdapter => {
    const set = (model: string, key: string, row: Row | undefined) => {
      const t = table(model);
      journal?.push({ model, key, row: t.get(key) });
      if (row === undefined) t.delete(key);
      else t.set(key, row);
    };
    const adapter: DatabaseAdapter = {
      async migrate(schema: Schema) {
        for (const [name, def] of Object.entries(schema)) pks.set(name, def.primaryKey);
      },
      async create(model, data) {
        const key = keyOf(model, data);
        if (table(model).has(key)) throw new Error(`Duplicate primary key in ${model}`);
        set(model, key, structuredClone(data));
      },
      async upsert(model, data) {
        set(model, keyOf(model, data), structuredClone(data));
      },
      async findOne(model, where) {
        for (const row of table(model).values()) if (matches(row, where)) return structuredClone(row);
        return null;
      },
      async findMany(model, opts: FindManyOptions = {}) {
        let rows = [...table(model).values()].filter((r) => matches(r, opts.where));
        if (opts.sortBy) {
          const { field, direction } = opts.sortBy;
          const dir = direction === "asc" ? 1 : -1;
          rows.sort((a, b) => (a[field] < b[field] ? -dir : a[field] > b[field] ? dir : 0));
        }
        if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);
        if (opts.fields?.length) return rows.map((r) => Object.fromEntries(opts.fields!.map((f) => [f, structuredClone(r[f] ?? null)])));
        return rows.map((r) => structuredClone(r));
      },
      async update(model, where, data) {
        let count = 0;
        // oxlint-disable-next-line unicorn/no-useless-spread -- copy on purpose: the loop removes entries
        for (const [key, row] of [...table(model).entries()]) {
          if (!matches(row, where)) continue;
          const updated = { ...row, ...structuredClone(data) };
          set(model, key, undefined);
          set(model, keyOf(model, updated), updated);
          count++;
        }
        return count;
      },
      async delete(model, where) {
        let count = 0;
        // oxlint-disable-next-line unicorn/no-useless-spread -- copy on purpose: the loop removes entries
        for (const [key, row] of [...table(model).entries()]) {
          if (matches(row, where)) {
            set(model, key, undefined);
            count++;
          }
        }
        return count;
      },
      async max(model, field) {
        let max: number | null = null;
        for (const row of table(model).values()) {
          const v = row[field];
          if (typeof v === "number" && (max === null || v > max)) max = v;
        }
        return max;
      },
      async transaction(fn) {
        const log: Journal = [];
        try {
          return await fn(build(log));
        } catch (err) {
          for (const entry of log.reverse()) {
            if (entry.row === undefined) table(entry.model).delete(entry.key);
            else table(entry.model).set(entry.key, entry.row);
          }
          throw err;
        }
      },
    };
    return adapter;
  };
  return build(null);
}
