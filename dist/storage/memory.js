import { AsyncLocalStorage } from "node:async_hooks";
export function matches(row, where = []) {
    for (const w of where) {
        const v = row[w.field] ?? null;
        const target = w.value ?? null;
        switch (w.operator ?? "eq") {
            case "eq":
                if (v !== target)
                    return false;
                break;
            case "ne":
                if (v === target)
                    return false;
                break;
            case "lt":
                if (!(v < target))
                    return false;
                break;
            case "lte":
                if (!(v <= target))
                    return false;
                break;
            case "gt":
                if (!(v > target))
                    return false;
                break;
            case "gte":
                if (!(v >= target))
                    return false;
                break;
            case "in":
                if (!target.includes(v))
                    return false;
                break;
        }
    }
    return true;
}
/** In-memory adapter. Data is lost on restart; useful for tests and development. */
export function memoryAdapter() {
    const tables = new Map();
    const pks = new Map();
    const table = (model) => {
        let t = tables.get(model);
        if (!t)
            tables.set(model, (t = new Map()));
        return t;
    };
    const keyOf = (model, row) => JSON.stringify((pks.get(model) ?? Object.keys(row)).map((k) => row[k]));
    const inTransaction = new AsyncLocalStorage();
    let gate = Promise.resolve();
    const build = (journal) => {
        const set = (model, key, row) => {
            const t = table(model);
            journal?.push({ model, key, row: t.get(key) });
            if (row === undefined)
                t.delete(key);
            else
                t.set(key, row);
        };
        const adapter = {
            async migrate(schema) {
                for (const [name, def] of Object.entries(schema))
                    pks.set(name, def.primaryKey);
            },
            async create(model, data) {
                const key = keyOf(model, data);
                if (table(model).has(key))
                    throw new Error(`Duplicate primary key in ${model}`);
                set(model, key, structuredClone(data));
            },
            async upsert(model, data) {
                set(model, keyOf(model, data), structuredClone(data));
            },
            async findOne(model, where) {
                for (const row of table(model).values())
                    if (matches(row, where))
                        return structuredClone(row);
                return null;
            },
            async findMany(model, opts = {}) {
                let rows = [...table(model).values()].filter((r) => matches(r, opts.where));
                if (opts.sortBy) {
                    const { field, direction } = opts.sortBy;
                    const dir = direction === "asc" ? 1 : -1;
                    rows.sort((a, b) => (a[field] < b[field] ? -dir : a[field] > b[field] ? dir : 0));
                }
                if (opts.limit !== undefined)
                    rows = rows.slice(0, opts.limit);
                if (opts.fields?.length)
                    return rows.map((r) => Object.fromEntries(opts.fields.map((f) => [f, structuredClone(r[f] ?? null)])));
                return rows.map((r) => structuredClone(r));
            },
            async update(model, where, data) {
                let count = 0;
                // oxlint-disable-next-line unicorn/no-useless-spread -- copy on purpose: the loop removes entries
                for (const [key, row] of [...table(model).entries()]) {
                    if (!matches(row, where))
                        continue;
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
                let max = null;
                for (const row of table(model).values()) {
                    const v = row[field];
                    if (typeof v === "number" && (max === null || v > max))
                        max = v;
                }
                return max;
            },
            async transaction(fn) {
                // Already inside a transaction (on this async path): join it.
                const current = inTransaction.getStore();
                if (current)
                    return fn(current);
                const previous = gate;
                let release;
                gate = new Promise((r) => (release = r));
                await previous;
                const log = [];
                const tx = build(log);
                try {
                    return await inTransaction.run(tx, () => fn(tx));
                }
                catch (err) {
                    for (const entry of log.reverse()) {
                        if (entry.row === undefined)
                            table(entry.model).delete(entry.key);
                        else
                            table(entry.model).set(entry.key, entry.row);
                    }
                    throw err;
                }
                finally {
                    release();
                }
            },
        };
        if (journal)
            return adapter;
        // https://github.com/k18k/katrix/issues/101: a rollback restores the values the transaction
        // replaced, so a write made meanwhile outside it was overwritten. Outside transactions, operations wait while
        // one is open; the check and the operation (synchronous in this adapter) run in the same step.
        const run = (op) => async (...args) => {
            if (inTransaction.getStore())
                return op(...args);
            for (;;) {
                const current = gate;
                await current;
                if (current === gate)
                    return op(...args);
            }
        };
        const outer = { ...adapter };
        for (const k of Object.keys(outer))
            if (k !== "transaction" && k !== "migrate")
                outer[k] = run(adapter[k]);
        return outer;
    };
    return build(null);
}
