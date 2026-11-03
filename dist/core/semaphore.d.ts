/** Runs at most `limit` tasks at once; the others wait their turn, first come first served. */
export declare class Semaphore {
    private readonly limit;
    private active;
    private waiting;
    constructor(limit: number);
    run<T>(fn: () => Promise<T>): Promise<T>;
}
