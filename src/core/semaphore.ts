/** Runs at most `limit` tasks at once; the others wait their turn, first come first served. */
export class Semaphore {
  private readonly limit: number;
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      // The slot passes straight to the next task, so `active` stays the same.
      if (next) next();
      else this.active--;
    }
  }
}
