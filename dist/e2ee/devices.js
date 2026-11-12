import { isObject } from "../shared/json.js";
import { Mutex } from "../util/mutex.js";
import { deviceKey } from "./crypto-store.js";
import { verifyObject } from "./keys.js";
// src/e2ee/devices.ts
/**
* Device list tracking (https://spec.matrix.org/v1.16/client-server-api/#tracking-the-device-list-for-a-user):
* users we share an encrypted room with are "tracked"; /sync's device_lists.changed marks them
* outdated, and their keys are queried again before we next encrypt for them.
*
* Every device's keys must be signed by the device's own Ed25519 key and name the right user and
* device. A device whose keys change is not updated: the spec's "Downloading keys" asks clients
* to reject a known device whose Ed25519 key changed (it would let the server swap in a key of its
* own), and the Curve25519 key is bound to it the same way here.
*/
var DeviceTracker = class {
	api;
	store;
	protocol;
	logger;
	mutex = new Mutex();
	constructor(opts) {
		this.api = opts.api;
		this.store = opts.store;
		this.protocol = opts.protocol;
		this.logger = opts.logger;
	}
	async getUser(userId, tx) {
		return tx ? tx.get("devices", deviceKey(userId)) : this.store.get("devices", deviceKey(userId));
	}
	async devices(userId, tx) {
		return Object.values((await this.getUser(userId, tx))?.devices ?? {});
	}
	/** The device of `userId` with this Curve25519 key, if known. */
	async deviceByCurveKey(userId, curve25519, tx) {
		return (await this.devices(userId, tx)).find((d) => d.curve25519 === curve25519);
	}
	/** Start tracking users (newly tracked ones are outdated until queried). */
	async track(tx, userIds) {
		for (const userId of userIds) {
			const rec = await tx.get("devices", deviceKey(userId));
			if (rec?.tracked) continue;
			tx.put("devices", deviceKey(userId), {
				devices: rec?.devices ?? {},
				tracked: true,
				outdated: (rec?.outdated ?? 0) + 1
			});
		}
	}
	/** device_lists from /sync. */
	async handleDeviceLists(tx, lists) {
		for (const userId of lists.changed) {
			const rec = await tx.get("devices", deviceKey(userId));
			if (rec?.tracked) tx.put("devices", deviceKey(userId), {
				...rec,
				outdated: rec.outdated + 1
			});
		}
		for (const userId of lists.left) {
			const rec = await tx.get("devices", deviceKey(userId));
			if (rec) tx.put("devices", deviceKey(userId), {
				...rec,
				tracked: false,
				outdated: 0
			});
		}
	}
	async isOutdated(userId) {
		const rec = await this.getUser(userId);
		return !rec || !rec.tracked || rec.outdated > 0;
	}
	/** Query keys of the given users that are outdated (all given users if `force`). */
	async refresh(userIds, opts = {}) {
		await this.mutex.run(async () => {
			const due = [];
			for (const userId of new Set(userIds)) {
				const rec = await this.getUser(userId);
				if (opts.force || !rec || !rec.tracked || rec.outdated > 0) due.push({
					userId,
					outdated: rec?.outdated ?? 0
				});
			}
			for (let i = 0; i < due.length; i += 100) await this.query(due.slice(i, i + 100));
		});
	}
	async query(batch) {
		if (batch.length === 0) return;
		const res = await this.api.endpoint("POST /v3/keys/query", {}, { body: {
			device_keys: Object.fromEntries(batch.map((b) => [b.userId, []])),
			timeout: 1e4
		} });
		const failedServers = new Set(Object.keys(res.failures ?? {}));
		await this.store.transaction(async (tx) => {
			for (const { userId, outdated } of batch) {
				const server = userId.slice(userId.indexOf(":") + 1);
				const answered = res.device_keys?.[userId];
				if (failedServers.has(server) || typeof answered !== "object" || answered === null) continue;
				const rec = await tx.get("devices", deviceKey(userId)) ?? {
					devices: {},
					tracked: true,
					outdated: 0
				};
				const crossSigning = this.crossSigningKeys(userId, res);
				const master = crossSigning.master ? publicKeyOf(crossSigning.master) : void 0;
				const trust = { ...rec.trust };
				if (master && !trust.pinnedMaster) trust.pinnedMaster = master;
				const devices = {};
				for (const [deviceId, keys] of Object.entries(answered)) {
					const device = this.validate(userId, deviceId, keys);
					if (!device) continue;
					const known = rec.devices[deviceId];
					if (known && (known.ed25519 !== device.ed25519 || known.curve25519 !== device.curve25519)) {
						this.logger.warn("ignoring changed keys of a known device", {
							userId,
							deviceId
						});
						devices[deviceId] = known;
						continue;
					}
					devices[deviceId] = device;
				}
				const current = (await tx.get("devices", deviceKey(userId)))?.outdated ?? 0;
				tx.put("devices", deviceKey(userId), {
					...rec,
					devices,
					tracked: true,
					outdated: current === outdated ? 0 : current,
					crossSigning,
					trust
				});
			}
		});
	}
	/**
	* A user's cross-signing keys from a query, each checked: it names the user, has the right
	* usage and one key, and the self-signing and user-signing keys carry the master key's
	* signature. Keys that fail are dropped (and with a bad master key, all of them).
	*/
	crossSigningKeys(userId, res) {
		const valid = (k, usage) => k && typeof k === "object" && k.user_id === userId && Array.isArray(k.usage) && k.usage.includes(usage) && publicKeyOf(k) !== void 0 ? k : void 0;
		const master = valid(res.master_keys?.[userId], "master");
		if (!master) return {};
		const mpk = publicKeyOf(master);
		const signedByMaster = (k) => k && verifyObject(this.protocol, k, userId, mpk, mpk) ? k : void 0;
		return {
			master,
			selfSigning: signedByMaster(valid(res.self_signing_keys?.[userId], "self_signing")),
			userSigning: signedByMaster(valid(res.user_signing_keys?.[userId], "user_signing"))
		};
	}
	/**
	* The users whose devices changed between two sync tokens (GET /keys/changes): they are marked
	* outdated, and their keys queried again before we next encrypt for them. For a client that
	* resumes from an older token than its device lists were last updated at.
	*/
	async changesBetween(from, to) {
		const res = await this.api.endpoint("GET /v3/keys/changes", {}, { query: {
			from,
			to
		} });
		const lists = {
			changed: res.changed ?? [],
			left: res.left ?? []
		};
		await this.store.transaction((tx) => this.handleDeviceLists(tx, lists));
		return lists;
	}
	/** Change what this device trusts about a user (the record is created if the user is not known yet). */
	async updateTrust(userId, change) {
		await this.store.transaction(async (tx) => {
			const rec = await tx.get("devices", deviceKey(userId)) ?? {
				devices: {},
				tracked: false,
				outdated: 1
			};
			tx.put("devices", deviceKey(userId), {
				...rec,
				trust: change({ ...rec.trust })
			});
		});
	}
	validate(userId, deviceId, keys) {
		if (!isObject(keys) || keys.user_id !== userId || keys.device_id !== deviceId) {
			this.logger.warn("device keys name another user or device", {
				userId,
				deviceId
			});
			return;
		}
		const keyMap = isObject(keys.keys) ? keys.keys : {};
		const ed25519 = keyMap[`ed25519:${deviceId}`];
		const curve25519 = keyMap[`curve25519:${deviceId}`];
		if (typeof ed25519 !== "string" || typeof curve25519 !== "string") return void 0;
		if (!verifyObject(this.protocol, keys, userId, deviceId, ed25519)) {
			this.logger.warn("device keys have no valid self-signature", {
				userId,
				deviceId
			});
			return;
		}
		const displayName = isObject(keys.unsigned) ? keys.unsigned.device_display_name : void 0;
		const { unsigned: _unsigned, ...signed } = keys;
		return {
			signed,
			userId,
			deviceId,
			curve25519,
			ed25519,
			algorithms: Array.isArray(keys.algorithms) ? keys.algorithms.filter((a) => typeof a === "string") : [],
			displayName: typeof displayName === "string" ? displayName : void 0
		};
	}
};
/** The one Ed25519 public key of a cross-signing key object. */
function publicKeyOf(key) {
	const entries = Object.entries(key.keys ?? {});
	if (entries.length !== 1) return void 0;
	const [id, value] = entries[0];
	return id === `ed25519:${value}` && typeof value === "string" ? value : void 0;
}
export { DeviceTracker, publicKeyOf };

//# sourceMappingURL=devices.js.map