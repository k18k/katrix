import type { Homeserver } from "../homeserver.ts";
import { CLUSTER_RESYNC } from "./cluster.ts";

/** Runtime server settings changed by admins (stored in the database, shared across instances). */
export class SettingsService {
  private hs: Homeserver;
  private cache = new Map<string, unknown>();

  constructor(hs: Homeserver) {
    this.hs = hs;
    hs.cluster.subscribe("settings", (msg: { key: string }) => this.cache.delete(msg?.key));
    hs.cluster.subscribe(CLUSTER_RESYNC, () => this.cache.clear());
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.cache.has(key)) return this.cache.get(key) as T | null;
    const row = await this.hs.db.findOne("server_settings", [{ field: "key", value: key }]);
    const value = (row?.value ?? null) as T | null;
    this.cache.set(key, value);
    return value;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.hs.db.upsert("server_settings", { key, value });
    this.cache.set(key, value);
    await this.hs.cluster.publish("settings", { key });
  }
}
