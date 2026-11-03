/**
 * In-memory storage: state lives as long as the process. Values are stored as the strings the
 * client writes, so state is copied in and out exactly as with a durable adapter.
 */
export class MemoryStorage {
    stores = new Map();
    store(name) {
        let s = this.stores.get(name);
        if (!s)
            this.stores.set(name, (s = new Map()));
        return s;
    }
    async get(store, key) {
        return this.stores.get(store)?.get(key);
    }
    async list(store, prefix) {
        const out = [];
        for (const entry of this.stores.get(store) ?? [])
            if (entry[0].startsWith(prefix))
                out.push(entry);
        return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    }
    /** Synchronous inside, so no other operation can see half of a batch. */
    async write(batch) {
        for (const op of batch) {
            if (op.type === "put")
                this.store(op.store).set(op.key, op.value);
            else
                this.stores.get(op.store)?.delete(op.key);
        }
    }
}
export function memoryStorage() {
    return new MemoryStorage();
}
