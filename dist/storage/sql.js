import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
/** Parameters per statement for multi-row writes: within SQLite's (32766), Postgres' and MySQL's (65535) limits. */
const MAX_PARAMS = 4000;
const OPS = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };
/**
 * Generic SQL adapter. Works with any driver that can run parameterised
 * queries; see `sqliteAdapter` and `postgresAdapter` for ready-made wrappers.
 */
export function sqlAdapter({ dialect, executor: rootExecutor, tablePrefix = "", transaction }) {
    let schema = {};
    const q = (ident) => (dialect === "mysql" ? `\`${ident}\`` : `"${ident}"`);
    const t = (model) => q(tablePrefix + model);
    const columnType = (type, isKey) => {
        switch (type) {
            case "string":
                return dialect === "mysql" ? (isKey ? "VARCHAR(255)" : "TEXT") : "TEXT";
            case "number":
                return dialect === "sqlite" ? "INTEGER" : "BIGINT";
            case "boolean":
                return dialect === "postgres" ? "BOOLEAN" : "INTEGER";
            case "json":
                return dialect === "mysql" ? "LONGTEXT" : "TEXT";
        }
    };
    const columnsOf = async (executor, table) => {
        const rows = dialect === "sqlite"
            ? await executor.query(`PRAGMA table_info(${q(table)})`, [])
            : dialect === "postgres"
                ? await executor.query("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1", [table])
                : await executor.query("SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?", [table]);
        return new Set(rows.map((r) => String(r.name)));
    };
    const fieldType = (model, field) => schema[model]?.fields[field]?.type ?? "string";
    const toDb = (model, field, value) => {
        if (value === undefined || value === null)
            return null;
        switch (fieldType(model, field)) {
            case "json":
                return JSON.stringify(value);
            case "boolean":
                return dialect === "postgres" ? !!value : value ? 1 : 0;
            default:
                return value;
        }
    };
    const fromDb = (model, row) => {
        const out = {};
        for (const [field, value] of Object.entries(row)) {
            if (value === null || value === undefined) {
                out[field] = null;
                continue;
            }
            switch (fieldType(model, field)) {
                case "json":
                    out[field] = typeof value === "string" ? JSON.parse(value) : value;
                    break;
                case "boolean":
                    out[field] = value === true || value === 1 || value === "1" || value === 1n;
                    break;
                case "number":
                    out[field] = Number(value);
                    break;
                default:
                    out[field] = value;
            }
        }
        return out;
    };
    const placeholder = (i) => (dialect === "postgres" ? `$${i}` : "?");
    // #40: a limit is a parameter, so the statement's text does not change with it.
    const limitClause = (limit, params) => {
        const n = Math.max(0, Math.floor(limit));
        if (dialect === "mysql")
            return ` LIMIT ${n}`;
        params.push(n);
        return ` LIMIT ${placeholder(params.length)}`;
    };
    const buildWhere = (model, where = [], params) => {
        if (where.length === 0)
            return "";
        const parts = where.map((w) => {
            const op = w.operator ?? "eq";
            if (op === "in") {
                const values = w.value;
                if (values.length === 0)
                    return "1=0";
                // https://github.com/k18k/katrix/issues/40: one array parameter, so the
                // statement's text does not change with the list's length and it can be prepared once.
                if (dialect === "postgres") {
                    params.push(values.map((v) => toDb(model, w.field, v)));
                    return `${q(w.field)} = ANY(${placeholder(params.length)})`;
                }
                const ph = values.map((v) => {
                    params.push(toDb(model, w.field, v));
                    return placeholder(params.length);
                });
                return `${q(w.field)} IN (${ph.join(", ")})`;
            }
            if (w.value === null || w.value === undefined) {
                if (op === "eq")
                    return `${q(w.field)} IS NULL`;
                if (op === "ne")
                    return `${q(w.field)} IS NOT NULL`;
            }
            params.push(toDb(model, w.field, w.value));
            return `${q(w.field)} ${OPS[op]} ${placeholder(params.length)}`;
        });
        return ` WHERE ${parts.join(" AND ")}`;
    };
    const build = (executor, inTx) => {
        // Rows written by one statement share their columns: `insert` is called per group of rows
        // with the same defined fields.
        const insert = async (model, data, mode) => {
            const rows = Array.isArray(data) ? data : [data];
            const fields = Object.keys(rows[0]).filter((k) => rows[0][k] !== undefined);
            const params = [];
            const values = rows.map((row) => `(${fields
                .map((f) => {
                params.push(toDb(model, f, row[f]));
                return placeholder(params.length);
            })
                .join(", ")})`);
            const cols = fields.map(q).join(", ");
            let sql = `INSERT INTO ${t(model)} (${cols}) VALUES ${values.join(", ")}`;
            if (mode === "upsert") {
                const pk = schema[model]?.primaryKey ?? [];
                const rest = fields.filter((f) => !pk.includes(f));
                if (dialect === "mysql") {
                    sql += rest.length
                        ? ` ON DUPLICATE KEY UPDATE ${rest.map((f) => `${q(f)} = VALUES(${q(f)})`).join(", ")}`
                        : ` ON DUPLICATE KEY UPDATE ${q(pk[0])} = ${q(pk[0])}`;
                }
                else {
                    sql += ` ON CONFLICT (${pk.map(q).join(", ")}) DO ${rest.length ? `UPDATE SET ${rest.map((f) => `${q(f)} = excluded.${q(f)}`).join(", ")}` : "NOTHING"}`;
                }
            }
            await executor.execute(sql, params);
        };
        const adapter = {
            async migrate(s) {
                schema = s;
                for (const [model, def] of Object.entries(s)) {
                    const cols = Object.entries(def.fields).map(([name, f]) => {
                        const isKey = def.primaryKey.includes(name) || (def.indexes ?? []).some((i) => i.includes(name));
                        return `${q(name)} ${columnType(f.type, isKey)}${f.required === false ? "" : " NOT NULL"}`;
                    });
                    cols.push(`PRIMARY KEY (${def.primaryKey.map(q).join(", ")})`);
                    const ine = "IF NOT EXISTS";
                    await executor.execute(`CREATE TABLE ${ine} ${t(model)} (${cols.join(", ")})`, []);
                    // Fields added to a model after its table was created become nullable columns
                    // (existing rows have no value for them).
                    const existing = await columnsOf(executor, tablePrefix + model);
                    for (const [name, f] of Object.entries(def.fields)) {
                        if (existing.has(name))
                            continue;
                        await executor.execute(`ALTER TABLE ${t(model)} ADD COLUMN ${q(name)} ${columnType(f.type, false)}`, []);
                    }
                    for (const index of def.indexes ?? []) {
                        const name = q(`idx_${tablePrefix}${model}_${index.join("_")}`);
                        if (dialect === "mysql") {
                            try {
                                await executor.execute(`CREATE INDEX ${name} ON ${t(model)} (${index.map(q).join(", ")})`, []);
                            }
                            catch {
                                /* index already exists */
                            }
                        }
                        else {
                            await executor.execute(`CREATE INDEX ${ine} ${name} ON ${t(model)} (${index.map(q).join(", ")})`, []);
                        }
                    }
                }
            },
            create: (model, data) => insert(model, data, "insert"),
            upsert: (model, data) => insert(model, data, "upsert"),
            // #39: rows grouped by their set of defined fields, de-duplicated by primary key (one
            // statement may not update a row twice), in chunks that keep parameters within every
            // driver's limit.
            async upsertMany(model, rows) {
                const pk = schema[model]?.primaryKey ?? [];
                const byKey = new Map();
                for (const row of rows)
                    byKey.set(JSON.stringify(pk.map((f) => row[f])), row);
                const groups = new Map();
                for (const row of byKey.values()) {
                    const shape = Object.keys(row)
                        .filter((k) => row[k] !== undefined)
                        .join("\0");
                    // https://github.com/k18k/katrix/issues/106: the group was copied for every row (quadratic).
                    let group = groups.get(shape);
                    if (!group)
                        groups.set(shape, (group = []));
                    group.push(row);
                }
                for (const group of groups.values()) {
                    const perStatement = Math.max(1, Math.floor(MAX_PARAMS / Object.keys(group[0]).length));
                    for (let i = 0; i < group.length; i += perStatement)
                        await insert(model, group.slice(i, i + perStatement), "upsert");
                }
            },
            async findOne(model, where) {
                const params = [];
                const rows = await executor.query(`SELECT * FROM ${t(model)}${buildWhere(model, where, params)} LIMIT 1`, params);
                return rows[0] ? fromDb(model, rows[0]) : null;
            },
            async findMany(model, opts = {}) {
                const params = [];
                const columns = opts.fields?.length ? opts.fields.map(q).join(", ") : "*";
                let sql = `SELECT ${columns} FROM ${t(model)}${buildWhere(model, opts.where, params)}`;
                if (opts.sortBy)
                    sql += ` ORDER BY ${q(opts.sortBy.field)} ${opts.sortBy.direction === "asc" ? "ASC" : "DESC"}`;
                if (opts.limit !== undefined)
                    sql += limitClause(opts.limit, params);
                const rows = await executor.query(sql, params);
                return rows.map((r) => fromDb(model, r));
            },
            // One round trip for several reads (Postgres): each read becomes one row, its index and its
            // rows as a JSON array.
            // https://github.com/k18k/katrix/issues/45: the rows used to be numbered
            // with row_number() and the whole union sorted, which took longer to plan than to run under
            // load; json_agg needs neither, and ORDER BY inside it keeps each read's order.
            ...(dialect === "postgres"
                ? {
                    async findManyBatch(queries, options) {
                        if (queries.length === 0)
                            return [];
                        const params = [];
                        const parts = queries.map(({ model, opts = {} }, i) => {
                            // The sort column is needed outside the subquery to order the aggregate.
                            const fields = opts.fields?.length && opts.sortBy && !opts.fields.includes(opts.sortBy.field)
                                ? [...opts.fields, opts.sortBy.field]
                                : opts.fields;
                            const columns = fields?.length ? fields.map(q).join(", ") : "*";
                            let inner = `SELECT ${columns} FROM ${t(model)}${buildWhere(model, opts.where, params)}`;
                            const direction = opts.sortBy?.direction === "asc" ? "ASC" : "DESC";
                            if (opts.sortBy)
                                inner += ` ORDER BY ${q(opts.sortBy.field)} ${direction}`;
                            if (opts.limit !== undefined)
                                inner += limitClause(opts.limit, params);
                            const aggOrder = opts.sortBy ? ` ORDER BY b.${q(opts.sortBy.field)} ${direction}` : "";
                            return `SELECT ${i} AS i, (SELECT json_agg(b${aggOrder}) FROM (${inner}) b) AS r`;
                        });
                        const rows = await executor.query(parts.join(" UNION ALL "), params, options);
                        const out = queries.map(() => []);
                        for (const row of rows) {
                            const list = typeof row.r === "string" ? JSON.parse(row.r) : row.r;
                            const model = queries[Number(row.i)].model;
                            out[Number(row.i)] = (list ?? []).map((r) => fromDb(model, r));
                        }
                        return out;
                    },
                }
                : {}),
            async update(model, where, data) {
                const fields = Object.keys(data).filter((k) => data[k] !== undefined);
                if (fields.length === 0)
                    return 0;
                const params = fields.map((f) => toDb(model, f, data[f]));
                const set = fields.map((f, i) => `${q(f)} = ${placeholder(i + 1)}`).join(", ");
                return executor.execute(`UPDATE ${t(model)} SET ${set}${buildWhere(model, where, params)}`, params);
            },
            async delete(model, where) {
                const params = [];
                return executor.execute(`DELETE FROM ${t(model)}${buildWhere(model, where, params)}`, params);
            },
            async max(model, field) {
                const rows = await executor.query(`SELECT MAX(${q(field)}) AS m FROM ${t(model)}`, []);
                const m = rows[0]?.m;
                return m === null || m === undefined ? null : Number(m);
            },
        };
        if (transaction) {
            adapter.transaction = (fn) => inTx ? fn(adapter) : transaction((ex) => fn(build(ex, true)));
        }
        return adapter;
    };
    return build(rootExecutor, false);
}
/** How long SQLite statements may run back to back before yielding to the event loop (#47, #52). */
const YIELD_AFTER_MS = 50;
/** Prepared statements an SQLite adapter keeps (#40). */
const STATEMENT_CACHE = 500;
/** SQLite adapter for `node:sqlite` (`new DatabaseSync(path)`) or `better-sqlite3`. */
export function sqliteAdapter(db, options = {}) {
    try {
        db.exec("PRAGMA journal_mode = WAL");
        // https://github.com/k18k/katrix/issues/46: with the default (FULL), every
        // commit waited for an fsync on the main thread. NORMAL is what SQLite recommends with WAL.
        db.exec(`PRAGMA synchronous = ${options.synchronous === "full" ? "FULL" : "NORMAL"}`);
    }
    catch {
        /* in-memory databases */
    }
    // https://github.com/k18k/katrix/issues/40: prepared statements by text, at
    // most STATEMENT_CACHE of them: IN lists make a text per length, and without a bound the cache
    // grew for as long as the process ran. A Map keeps insertion order, so re-inserting on use and
    // dropping the first entry evicts the least recently used one.
    const cache = new Map();
    const stmt = (sql) => {
        let s = cache.get(sql);
        if (s)
            cache.delete(sql);
        else
            s = db.prepare(sql);
        cache.set(sql, s);
        if (cache.size > STATEMENT_CACHE)
            cache.delete(cache.keys().next().value);
        return s;
    };
    // A single connection is shared, so statements from other requests must wait
    // while a transaction is open. Code running inside the transaction bypasses the gate.
    const inTransaction = new AsyncLocalStorage();
    let gate = Promise.resolve();
    // https://github.com/k18k/katrix/issues/47: statements run synchronously and
    // resolve as microtasks, so a wave of requests full of reads ran as one chain that never let the
    // event loop take new requests or fire timers, for seconds under load. Outside transactions, a
    // statement first yields to the event loop when the last yield is more than YIELD_AFTER_MS ago.
    // https://github.com/k18k/katrix/issues/52: that chain came from tasks handing
    // over to each other in their microtasks, which no longer happens (see Semaphore); this is a
    // backstop, as yielding every 10 ms under load made each statement wait a full turn of a busy
    // event loop, and a send with twenty statements took seconds.
    let lastYield = performance.now();
    // https://github.com/k18k/katrix/issues/95: a statement used to wait for the gate and run in a
    // later microtask, and a transaction could claim the gate and BEGIN in between: the statement then ran inside
    // that transaction and was undone by its rollback, though it had reported success. The check that the gate is
    // still free and the statement now run in the same synchronous step; a gate claimed meanwhile is waited for.
    const run = async (statement) => {
        if (inTransaction.getStore())
            return statement();
        for (;;) {
            const current = gate;
            await current;
            if (performance.now() - lastYield > YIELD_AFTER_MS) {
                await new Promise((resolve) => setImmediate(resolve));
                lastYield = performance.now();
                continue;
            }
            if (current === gate)
                return statement();
        }
    };
    const executor = {
        query: (sql, params) => run(() => stmt(sql).all(...params)),
        execute: (sql, params) => run(() => Number(stmt(sql).run(...params).changes)),
    };
    return sqlAdapter({
        dialect: "sqlite",
        tablePrefix: options.tablePrefix,
        executor,
        async transaction(fn) {
            // Already inside a transaction (on this async path): join it instead of deadlocking on the gate.
            if (inTransaction.getStore())
                return fn(executor);
            const previous = gate;
            let release;
            gate = new Promise((r) => (release = r));
            await previous;
            try {
                return await inTransaction.run(true, async () => {
                    db.exec("BEGIN IMMEDIATE");
                    try {
                        const result = await fn(executor);
                        db.exec("COMMIT");
                        return result;
                    }
                    catch (err) {
                        db.exec("ROLLBACK");
                        throw err;
                    }
                });
            }
            finally {
                release();
            }
        },
    });
}
/**
 * https://github.com/k18k/katrix/issues/91: when Postgres restarts or drops a connection, `pg`
 * emits "error" on the pool (for idle clients) and on a checked-out client between two queries. Unheard, that
 * event ended the process. The pool replaces broken idle clients, and a query on a broken client fails on its
 * own, so the event needs no more than a listener.
 */
export const ignorePgError = () => { };
/**
 * https://github.com/k18k/katrix/issues/40: unnamed statements are parsed and
 * planned by Postgres on every call, which took most of its CPU under load. Named ones are prepared
 * once per connection and reused. Statement texts depend only on the code (lists and limits are
 * parameters), so there are a few hundred of them; past `MAX_PREPARED` distinct texts, further
 * ones run unnamed, which bounds the memory both node-postgres and Postgres keep per connection.
 */
const MAX_PREPARED = 2000;
function statementNamer(enabled) {
    let names = new Map();
    let generation = 0;
    return {
        name(sql) {
            if (!enabled)
                return undefined;
            let name = names.get(sql);
            if (!name && names.size < MAX_PREPARED)
                names.set(sql, (name = `m${generation}_${createHash("sha1").update(sql).digest("base64url")}`));
            return name;
        },
        reset() {
            names = new Map();
            generation++;
        },
    };
}
/**
 * A prepared `SELECT *` fails once its table has gained a column, for example when another node of
 * a cluster migrated the schema during a rolling update. Then the statements are prepared again
 * under new names and the query is retried once.
 */
const isStalePlan = (err) => err?.code === "0A000" && /cached plan/.test(String(err.message));
const pgExecutor = (conn, namer) => {
    const run = async (sql, params, prepare = true) => {
        const name = () => (prepare ? namer.name(sql) : undefined);
        try {
            return await conn.query({ text: sql, values: params, name: name() });
        }
        catch (err) {
            if (!isStalePlan(err))
                throw err;
            namer.reset();
            return conn.query({ text: sql, values: params, name: name() });
        }
    };
    return {
        async query(sql, params, options) {
            return (await run(sql, params, options?.prepare)).rows;
        },
        async execute(sql, params) {
            return (await run(sql, params)).rowCount ?? 0;
        },
    };
};
/** PostgreSQL adapter for `pg` (node-postgres). Pass a `Pool` to get transactions. */
export function postgresAdapter(pool, options = {}) {
    const namer = statementNamer(options.preparedStatements ?? true);
    pool.on?.("error", ignorePgError);
    return sqlAdapter({
        dialect: "postgres",
        tablePrefix: options.tablePrefix,
        executor: pgExecutor(pool, namer),
        transaction: pool.connect
            ? async (fn) => {
                const client = await pool.connect();
                client.on?.("error", ignorePgError);
                try {
                    await client.query({ text: "BEGIN" });
                    const result = await fn(pgExecutor(client, namer));
                    await client.query({ text: "COMMIT" });
                    return result;
                }
                catch (err) {
                    await client.query({ text: "ROLLBACK" }).catch(() => { });
                    throw err;
                }
                finally {
                    client.off?.("error", ignorePgError);
                    client.release();
                }
            }
            : undefined,
    });
}
const mysqlExecutor = (conn) => ({
    async query(sql, params) {
        return (await conn.query(sql, params))[0];
    },
    async execute(sql, params) {
        return (await conn.query(sql, params))[0]?.affectedRows ?? 0;
    },
});
/** MySQL / MariaDB adapter for `mysql2/promise` pools. */
export function mysqlAdapter(pool, options = {}) {
    return sqlAdapter({
        dialect: "mysql",
        tablePrefix: options.tablePrefix,
        executor: mysqlExecutor(pool),
        transaction: pool.getConnection
            ? async (fn) => {
                const conn = await pool.getConnection();
                try {
                    await conn.query("START TRANSACTION");
                    const result = await fn(mysqlExecutor(conn));
                    await conn.query("COMMIT");
                    return result;
                }
                catch (err) {
                    await conn.query("ROLLBACK").catch(() => { });
                    throw err;
                }
                finally {
                    conn.release();
                }
            }
            : undefined,
    });
}
