/** Runs tasks one at a time, in order of arrival. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  }
}

/** One Mutex per key (a room, a device), created on demand and dropped when idle. */
export class KeyedMutex {
  private locks = new Map<string, { mutex: Mutex; users: number }>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    let entry = this.locks.get(key);
    if (!entry) this.locks.set(key, (entry = { mutex: new Mutex(), users: 0 }));
    entry.users++;
    try {
      return await entry.mutex.run(task);
    } finally {
      if (--entry.users === 0) this.locks.delete(key);
    }
  }
}
