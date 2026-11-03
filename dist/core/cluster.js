import { AsyncLocalStorage } from "node:async_hooks";
import { randomString } from "#core/crypto.ts";
/**
 * A local signal (never published) that a cluster adapter may have missed messages, as after its
 * connection to the other instances was lost: subscribers drop what they cached of shared state (#92).
 */
export const CLUSTER_RESYNC = "__cluster_resync";
/** Checks of the leased cluster locks the current code runs under, innermost last. */
const leases = new AsyncLocalStorage();
/** Run `fn` under a leased lock whose `check` throws once the lease is lost. */
export function underLease(check, fn) {
    return leases.run([...(leases.getStore() ?? []), check], fn);
}
/** Throw when a leased cluster lock the current code runs under has been lost (#57). */
export function assertLeases() {
    for (const check of leases.getStore() ?? [])
        check();
}
/** In-process cluster adapter: a single homeserver instance. */
export function localCluster() {
    const sequences = new Map();
    const locks = new Map();
    const handlers = new Map();
    const kv = new Map();
    const live = (key) => {
        const e = kv.get(key);
        if (!e)
            return undefined;
        if (e.expires && e.expires < Date.now()) {
            kv.delete(key);
            return undefined;
        }
        return e;
    };
    return {
        async nextId(seq) {
            const v = (sequences.get(seq) ?? 0) + 1;
            sequences.set(seq, v);
            return v;
        },
        async currentId(seq) {
            return sequences.get(seq) ?? 0;
        },
        async advance(seq, value) {
            if (value > (sequences.get(seq) ?? 0))
                sequences.set(seq, value);
        },
        async lock(key, fn) {
            const prev = locks.get(key) ?? Promise.resolve();
            const run = prev.then(fn, fn);
            const settled = run.catch(() => { });
            locks.set(key, settled);
            try {
                return await run;
            }
            finally {
                if (locks.get(key) === settled)
                    locks.delete(key);
            }
        },
        async publish(channel, message) {
            for (const h of handlers.get(channel) ?? [])
                queueMicrotask(() => h(message));
        },
        subscribe(channel, handler) {
            let set = handlers.get(channel);
            if (!set)
                handlers.set(channel, (set = new Set()));
            set.add(handler);
        },
        async get(key) {
            return (live(key)?.value ?? null);
        },
        async set(key, value, ttlMs) {
            kv.set(key, { value, expires: ttlMs ? Date.now() + ttlMs : 0 });
        },
        async setIfAbsent(key, value, ttlMs) {
            if (live(key))
                return false;
            kv.set(key, { value, expires: ttlMs ? Date.now() + ttlMs : 0 });
            if (kv.size > 200_000)
                for (const k of kv.keys()) {
                    if (!live(k))
                        kv.delete(k);
                }
            return true;
        },
        async delete(key) {
            kv.delete(key);
        },
        async entries(prefix) {
            const out = [];
            // oxlint-disable-next-line unicorn/no-useless-spread -- copy on purpose: the loop removes entries
            for (const k of [...kv.keys()])
                if (k.startsWith(prefix)) {
                    const e = live(k);
                    if (e)
                        out.push([k, e.value]);
                }
            return out;
        },
    };
}
const WRITER_TTL_MS = 30_000;
/**
 * A stream position held longer than this holds back /sync for everyone: it is logged with where
 * it was allocated (https://github.com/k18k/katrix/issues/48).
 */
const SLOW_LEASE_MS = 5_000;
/**
 * Stream positions with multiple writers. Positions are allocated from a global
 * sequence; readers only see positions up to which every writer has finished, so
 * an event committed late with a lower position can never be skipped by /sync.
 *
 * Each writer publishes `{ busy, pos }`: when busy, all of its positions ≤ pos are
 * persisted. Readers use min(global, busy writers' pos).
 */
export class StreamManager {
    cluster;
    instanceId;
    inflight = new Set();
    /** Allocations waiting for a publish that covers them. */
    reserving = 0;
    /** Allocations whose publish is done, asking the sequence for their position now. */
    allocating = 0;
    /** The position of the last published busy state: below every position still being allocated. */
    lastPos = 0;
    heartbeat;
    positionCache = null;
    highestAllocated = 0;
    /** Called after a write of this instance completed, when the position may have moved (#50). */
    onAdvance = () => { };
    // https://github.com/k18k/katrix/issues/30: every allocation from idle and every
    // completion used to append to one chain of round trips (read the sequence, write the state),
    // so all stream writes of an instance completed one at a time. Publishes are now shared: a
    // caller waits for the next publish that starts after its change, and everyone who changed
    // state before that publish started rides on it (group commit). Publishes still run one after
    // another, so a newer state is never overwritten by an older one.
    publishing = Promise.resolve();
    nextPublish = null;
    warn;
    constructor(cluster, instanceId, warn = () => { }) {
        this.cluster = cluster;
        this.instanceId = instanceId;
        this.warn = warn;
        this.heartbeat = setInterval(() => void this.flush().catch(() => { }), WRITER_TTL_MS / 3);
        this.heartbeat.unref?.();
    }
    key() {
        return `writer:${this.instanceId}`;
    }
    /** Publish this writer's state as it is when the publish starts; concurrent callers share it. */
    flush() {
        if (this.nextPublish)
            return this.nextPublish;
        const run = async () => {
            // From here on, changes need a later publish. The reservations so far are covered by this
            // one: once it is out, they go on to take their positions.
            this.nextPublish = null;
            const covered = this.reserving;
            const earlier = this.allocating;
            this.reserving = 0;
            this.allocating += covered;
            // The published position must be below every position not yet persisted:
            // - in flight: below the lowest one;
            // - allocations covered by an earlier publish may be taking positions right now: that
            //   publish's position is below them;
            // - the ones covered now take theirs after this publish: the sequence as it is now.
            const bounds = [];
            if (this.inflight.size)
                bounds.push(Math.min(...this.inflight) - 1);
            if (earlier)
                bounds.push(this.lastPos);
            if (covered)
                bounds.push(await this.cluster.currentId("stream"));
            const state = bounds.length ? { busy: true, pos: Math.min(...bounds) } : { busy: false, pos: 0 };
            if (state.busy)
                this.lastPos = state.pos;
            await this.cluster.set(this.key(), state, WRITER_TTL_MS);
        };
        const p = this.publishing.then(run, run);
        this.nextPublish = p;
        this.publishing = p.catch(() => { });
        return p;
    }
    /** Allocate a position. The caller must call `done()` once its writes are committed. */
    async allocate() {
        // Be published as busy (with a position below anything we allocate) before allocating, so
        // readers never overtake us. The publish moves this reservation to `allocating`.
        this.reserving++;
        let id;
        try {
            await this.flush();
            id = await this.cluster.nextId("stream");
            this.inflight.add(id);
            if (id > this.highestAllocated)
                this.highestAllocated = id;
        }
        finally {
            this.allocating--;
        }
        let finished = false;
        // Where the position was allocated, for the slow-lease warning (#48). The stack is only
        // formatted if the warning is logged.
        const site = new Error("stream position allocated here");
        const slow = setTimeout(() => this.warn(`Stream position ${id} held for over ${SLOW_LEASE_MS} ms; /sync waits for it`, site), SLOW_LEASE_MS);
        slow.unref?.();
        const timer = setTimeout(() => void lease.done(), 60_000);
        timer.unref?.();
        const lease = {
            id,
            done: async () => {
                if (finished)
                    return;
                finished = true;
                clearTimeout(timer);
                clearTimeout(slow);
                this.inflight.delete(id);
                await this.flush();
                this.positionCache = null;
                this.onAdvance();
            },
        };
        return lease;
    }
    /** Allocate a position, run `fn` with it, then complete it. */
    async write(fn) {
        const lease = await this.allocate();
        try {
            return await fn(lease.id);
        }
        finally {
            await lease.done();
        }
    }
    /** A fresh decreasing position for backfilled (historical) events. */
    async backfillId() {
        return -(await this.cluster.nextId("backfill"));
    }
    /** The highest position this instance has allocated: an upper bound of its changes so far. */
    get lastAllocated() {
        return this.highestAllocated;
    }
    /**
     * The highest position below which everything is persisted, cluster-wide. `fresh` skips the
     * 20 ms cache, for a caller that knows a change has completed elsewhere.
     */
    async position(fresh = false) {
        if (!fresh && this.positionCache && Date.now() - this.positionCache.at < 20)
            return this.positionCache.value;
        // Read the global sequence first, then the writers (see class comment).
        const global = await this.cluster.currentId("stream");
        let pos = global;
        for (const [, w] of await this.cluster.entries("writer:")) {
            if (w?.busy)
                pos = Math.min(pos, w.pos);
        }
        if (this.inflight.size)
            pos = Math.min(pos, Math.min(...this.inflight) - 1);
        this.positionCache = { value: pos, at: Date.now() };
        return pos;
    }
    /**
     * Resolve once the position has reached `pos` (true), or false after `timeoutMs` or on abort.
     * For a request woken by a change that another write in flight still keeps out of sight
     * (https://github.com/k18k/katrix/issues/50). It checks again at growing
     * intervals: writes finish in milliseconds, and the position may be held by another instance.
     */
    async waitFor(pos, timeoutMs, signal) {
        const deadline = Date.now() + timeoutMs;
        let delay = 5;
        for (;;) {
            if ((await this.position(true)) >= pos)
                return true;
            const left = deadline - Date.now();
            if (left <= 0 || signal?.aborted)
                return false;
            await new Promise((resolve) => setTimeout(resolve, Math.min(delay, left)));
            delay = Math.min(delay * 2, 200);
        }
    }
    async advanceTo(value) {
        await this.cluster.advance("stream", value);
    }
    async lowerBackfillTo(value) {
        if (value < 0)
            await this.cluster.advance("backfill", -value);
    }
    async stop() {
        clearInterval(this.heartbeat);
        await this.cluster.delete(this.key()).catch(() => { });
    }
}
export function newInstanceId() {
    return `${process.pid}-${randomString(8)}`;
}
