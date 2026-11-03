/** Runs tasks one at a time, in order of arrival. */
export declare class Mutex {
    private tail;
    run<T>(task: () => Promise<T>): Promise<T>;
}
/** One Mutex per key (a room, a device), created on demand and dropped when idle. */
export declare class KeyedMutex {
    private locks;
    run<T>(key: string, task: () => Promise<T>): Promise<T>;
}
