// src/util/mutex.ts
/** Runs tasks one at a time, in order of arrival. */
var Mutex = class {
	tail = Promise.resolve();
	run(task) {
		const result = this.tail.then(task, task);
		this.tail = result.catch(() => {});
		return result;
	}
};
/** One Mutex per key (a room, a device), created on demand and dropped when idle. */
var KeyedMutex = class {
	locks = /* @__PURE__ */ new Map();
	async run(key, task) {
		let entry = this.locks.get(key);
		if (!entry) this.locks.set(key, entry = {
			mutex: new Mutex(),
			users: 0
		});
		entry.users++;
		try {
			return await entry.mutex.run(task);
		} finally {
			if (--entry.users === 0) this.locks.delete(key);
		}
	}
};
export { KeyedMutex, Mutex };

//# sourceMappingURL=mutex.js.map