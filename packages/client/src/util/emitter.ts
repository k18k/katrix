/** A small typed event emitter (no node:events: it must run in browsers and React Native). */

export type Listener<A extends unknown[]> = (...args: A) => void;

export class TypedEmitter<Events extends { [K in keyof Events]: unknown[] }> {
  private listeners = new Map<keyof Events, Set<Listener<any>>>();
  /** Called when a listener throws; the emitter itself never throws to the code that emits. */
  protected onListenerError: (event: keyof Events, error: unknown) => void = () => {};

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => this.off(event, listener);
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const wrapped: Listener<Events[K]> = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener);
  }

  removeAllListeners(event?: keyof Events): void {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
  }

  /**
   * Calls listeners synchronously in registration order. A listener that throws does not stop the
   * others, nor the sync loop that emitted: the error goes to onListenerError.
   */
  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // A copy: listeners added while emitting are not called for this event.
    for (const l of Array.from(set)) {
      try {
        l(...args);
      } catch (e) {
        this.onListenerError(event, e);
      }
    }
  }

  /** Resolves with the arguments of the next `event` that passes `filter`. */
  waitFor<K extends keyof Events>(event: K, filter: (...args: Events[K]) => boolean = () => true): Promise<Events[K]> {
    return new Promise((resolve) => {
      const off = this.on(event, (...args) => {
        if (!filter(...args)) return;
        off();
        resolve(args);
      });
    });
  }
}
