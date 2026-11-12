/** A small typed event emitter (no node:events: it must run in browsers and React Native). */
export type Listener<A extends unknown[]> = (...args: A) => void;
export declare class TypedEmitter<Events extends { [K in keyof Events]: unknown[]; }> {
  private listeners;
  /** Called when a listener throws; the emitter itself never throws to the code that emits. */
  protected onListenerError: (event: keyof Events, error: unknown) => void;
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void;
  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void;
  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void;
  removeAllListeners(event?: keyof Events): void;
  /**
   * Calls listeners synchronously in registration order. A listener that throws does not stop the
   * others, nor the sync loop that emitted: the error goes to onListenerError.
   */
  emit<K extends keyof Events>(event: K, ...args: Events[K]): void;
  /** Resolves with the arguments of the next `event` that passes `filter`. */
  waitFor<K extends keyof Events>(event: K, filter?: (...args: Events[K]) => boolean): Promise<Events[K]>;
}
//# sourceMappingURL=emitter.d.ts.map