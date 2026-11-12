import { CLUSTER_RESYNC } from "./cluster.js";
// src/core/settings.ts
/** Runtime server settings changed by admins (stored in the database, shared across instances). */
var SettingsService = class {
	hs;
	cache = /* @__PURE__ */ new Map();
	constructor(hs) {
		this.hs = hs;
		hs.cluster.subscribe("settings", (msg) => this.cache.delete(msg?.key));
		hs.cluster.subscribe(CLUSTER_RESYNC, () => this.cache.clear());
	}
	async get(key) {
		if (this.cache.has(key)) return this.cache.get(key);
		const value = (await this.hs.db.findOne("server_settings", [{
			field: "key",
			value: key
		}]))?.value ?? null;
		this.cache.set(key, value);
		return value;
	}
	async set(key, value) {
		await this.hs.db.upsert("server_settings", {
			key,
			value
		});
		this.cache.set(key, value);
		await this.hs.cluster.publish("settings", { key });
	}
};
export { SettingsService };

//# sourceMappingURL=settings.js.map