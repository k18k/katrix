// src/core/semaphore.ts
/** Runs at most `limit` tasks at once; the others wait their turn, first come first served. */
var Semaphore = class {
	limit;
	active = 0;
	waiting = [];
	constructor(limit) {
		this.limit = limit;
	}
	async run(fn) {
		if (this.active >= this.limit) await new Promise((resolve) => this.waiting.push(resolve));
		else this.active++;
		try {
			return await fn();
		} finally {
			const next = this.waiting.shift();
			if (next) setImmediate(next);
			else this.active--;
		}
	}
};
export { Semaphore };

//# sourceMappingURL=semaphore.js.map