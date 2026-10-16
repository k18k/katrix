import type { ClusterAdapter } from "#core/cluster.ts";

/**
 * Wakes long-polling `/sync` requests when something relevant happens. Notifications
 * are broadcast through the cluster adapter so waiters on other instances wake too.
 */
export class Notifier {
  private waiters = new Map<string, Set<() => void>>();
  private cluster: ClusterAdapter;
  private instanceId: string;

  constructor(cluster: ClusterAdapter, instanceId: string) {
    this.cluster = cluster;
    this.instanceId = instanceId;
    cluster.subscribe("notify", (msg: { from: string; users: string[] }) => {
      if (msg?.from !== this.instanceId && Array.isArray(msg?.users)) this.wakeLocal(msg.users);
    });
  }

  notify(userIds: Iterable<string>): void {
    const users = [...userIds];
    if (!users.length) return;
    this.wakeLocal(users);
    void this.cluster.publish("notify", { from: this.instanceId, users }).catch(() => {});
  }

  private wakeLocal(userIds: Iterable<string>): void {
    for (const u of userIds) {
      const set = this.waiters.get(u);
      if (!set) continue;
      this.waiters.delete(u);
      for (const wake of set) wake();
    }
  }

  notifyAll(): void {
    this.wakeLocal([...this.waiters.keys()]);
  }

  wait(userId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiters.get(userId);
      if (!set) this.waiters.set(userId, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        set!.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", done, { once: true });
      set.add(done);
    });
  }
}
