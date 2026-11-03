/** Runs at most `limit` tasks at once; the others wait their turn, first come first served. */
export class Semaphore {
    limit;
    active = 0;
    waiting = [];
    constructor(limit) {
        this.limit = limit;
    }
    async run(fn) {
        if (this.active >= this.limit)
            await new Promise((resolve) => this.waiting.push(resolve));
        else
            this.active++;
        try {
            return await fn();
        }
        finally {
            const next = this.waiting.shift();
            // The slot passes straight to the next task, so `active` stays the same. It starts in a turn
            // of its own (https://github.com/k18k/katrix/issues/52): resolved here, each
            // task would start in the microtasks of the one before, and with a synchronous database a
            // queue of tasks ran as one chain that kept the event loop from anything else.
            if (next)
                setImmediate(next);
            else
                this.active--;
        }
    }
}
