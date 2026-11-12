// src/util/emitter.ts
var TypedEmitter = class {
	listeners = /* @__PURE__ */ new Map();
	/** Called when a listener throws; the emitter itself never throws to the code that emits. */
	onListenerError = () => {};
	on(event, listener) {
		let set = this.listeners.get(event);
		if (!set) this.listeners.set(event, set = /* @__PURE__ */ new Set());
		set.add(listener);
		return () => this.off(event, listener);
	}
	once(event, listener) {
		const wrapped = (...args) => {
			this.off(event, wrapped);
			listener(...args);
		};
		return this.on(event, wrapped);
	}
	off(event, listener) {
		this.listeners.get(event)?.delete(listener);
	}
	removeAllListeners(event) {
		if (event === void 0) this.listeners.clear();
		else this.listeners.delete(event);
	}
	/**
	* Calls listeners synchronously in registration order. A listener that throws does not stop the
	* others, nor the sync loop that emitted: the error goes to onListenerError.
	*/
	emit(event, ...args) {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const l of Array.from(set)) try {
			l(...args);
		} catch (e) {
			this.onListenerError(event, e);
		}
	}
	/** Resolves with the arguments of the next `event` that passes `filter`. */
	waitFor(event, filter = () => true) {
		return new Promise((resolve) => {
			const off = this.on(event, (...args) => {
				if (!filter(...args)) return;
				off();
				resolve(args);
			});
		});
	}
};
export { TypedEmitter };

//# sourceMappingURL=emitter.js.map