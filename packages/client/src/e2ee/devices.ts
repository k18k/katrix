import type { MatrixHttpApi } from "../http/api.ts";
import type { E2EEProtocol } from "../protocol/protocol.ts";
import type { Store, Transaction } from "../storage/store.ts";
import type { Logger } from "../util/logger.ts";
import { Mutex } from "../util/mutex.ts";
import type { CrossSigningKey, KeysQueryResponse } from "@katrix/shared";
import { deviceKey, type CrossSigningKeys, type DeviceInfo, type UserDevicesRecord, type UserTrustRecord } from "./crypto-store.ts";
import { verifyObject } from "./keys.ts";

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
export class DeviceTracker {
  private readonly api: MatrixHttpApi;
  private readonly store: Store;
  private readonly protocol: E2EEProtocol;
  private readonly logger: Logger;
  private readonly mutex = new Mutex();

  constructor(opts: { api: MatrixHttpApi; store: Store; protocol: E2EEProtocol; logger: Logger }) {
    this.api = opts.api;
    this.store = opts.store;
    this.protocol = opts.protocol;
    this.logger = opts.logger;
  }

  async getUser(userId: string, tx?: Transaction): Promise<UserDevicesRecord | undefined> {
    return tx ? tx.get<UserDevicesRecord>("devices", deviceKey(userId)) : this.store.get<UserDevicesRecord>("devices", deviceKey(userId));
  }

  async devices(userId: string, tx?: Transaction): Promise<DeviceInfo[]> {
    return Object.values((await this.getUser(userId, tx))?.devices ?? {});
  }

  /** The device of `userId` with this Curve25519 key, if known. */
  async deviceByCurveKey(userId: string, curve25519: string, tx?: Transaction): Promise<DeviceInfo | undefined> {
    return (await this.devices(userId, tx)).find((d) => d.curve25519 === curve25519);
  }

  /** Start tracking users (newly tracked ones are outdated until queried). */
  async track(tx: Transaction, userIds: Iterable<string>): Promise<void> {
    for (const userId of userIds) {
      const rec = await tx.get<UserDevicesRecord>("devices", deviceKey(userId));
      if (rec?.tracked) continue;
      tx.put("devices", deviceKey(userId), { devices: rec?.devices ?? {}, tracked: true, outdated: (rec?.outdated ?? 0) + 1 });
    }
  }

  /** device_lists from /sync. */
  async handleDeviceLists(tx: Transaction, lists: { changed: string[]; left: string[] }): Promise<void> {
    for (const userId of lists.changed) {
      const rec = await tx.get<UserDevicesRecord>("devices", deviceKey(userId));
      if (rec?.tracked) tx.put("devices", deviceKey(userId), { ...rec, outdated: rec.outdated + 1 });
    }
    for (const userId of lists.left) {
      const rec = await tx.get<UserDevicesRecord>("devices", deviceKey(userId));
      // No shared encrypted room any more: stop tracking; the known keys stay (for decryption).
      if (rec) tx.put("devices", deviceKey(userId), { ...rec, tracked: false, outdated: 0 });
    }
  }

  async isOutdated(userId: string): Promise<boolean> {
    const rec = await this.getUser(userId);
    return !rec || !rec.tracked || rec.outdated > 0;
  }

  /** Query keys of the given users that are outdated (all given users if `force`). */
  async refresh(userIds: string[], opts: { force?: boolean } = {}): Promise<void> {
    await this.mutex.run(async () => {
      const due: Array<{ userId: string; outdated: number }> = [];
      for (const userId of new Set(userIds)) {
        const rec = await this.getUser(userId);
        if (opts.force || !rec || !rec.tracked || rec.outdated > 0) due.push({ userId, outdated: rec?.outdated ?? 0 });
      }
      // Batches keep request bodies (and remote servers' answers) to a sensible size.
      for (let i = 0; i < due.length; i += 100) await this.query(due.slice(i, i + 100));
    });
  }

  private async query(batch: Array<{ userId: string; outdated: number }>): Promise<void> {
    if (batch.length === 0) return;
    const res = await this.api.endpoint(
      "POST /v3/keys/query",
      {},
      {
        body: { device_keys: Object.fromEntries(batch.map((b) => [b.userId, []])), timeout: 10_000 },
      },
    );
    const failedServers = new Set(Object.keys(res.failures ?? {}));
    await this.store.transaction(async (tx) => {
      for (const { userId, outdated } of batch) {
        const server = userId.slice(userId.indexOf(":") + 1);
        const answered = res.device_keys?.[userId];
        if (failedServers.has(server) || typeof answered !== "object" || answered === null) continue;
        const rec = (await tx.get<UserDevicesRecord>("devices", deviceKey(userId))) ?? { devices: {}, tracked: true, outdated: 0 };
        const crossSigning = this.crossSigningKeys(userId, res);
        // Trust on first use: the first master key seen is pinned; a later different one is an
        // identity change the app must show (https://spec.matrix.org/v1.19/client-server-api/#key-and-signature-security).
        const master = crossSigning.master ? publicKeyOf(crossSigning.master) : undefined;
        const trust = { ...rec.trust };
        if (master && !trust.pinnedMaster) trust.pinnedMaster = master;
        const devices: Record<string, DeviceInfo> = {};
        for (const [deviceId, keys] of Object.entries(answered)) {
          const device = this.validate(userId, deviceId, keys);
          if (!device) continue;
          const known = rec.devices[deviceId];
          if (known && (known.ed25519 !== device.ed25519 || known.curve25519 !== device.curve25519)) {
            this.logger.warn("ignoring changed keys of a known device", { userId, deviceId });
            devices[deviceId] = known;
            continue;
          }
          devices[deviceId] = device;
        }
        // Still outdated if another change was announced while this query ran.
        const current = (await tx.get<UserDevicesRecord>("devices", deviceKey(userId)))?.outdated ?? 0;
        tx.put("devices", deviceKey(userId), {
          ...rec,
          devices,
          tracked: true,
          outdated: current === outdated ? 0 : current,
          crossSigning,
          trust,
        } satisfies UserDevicesRecord);
      }
    });
  }

  /**
   * A user's cross-signing keys from a query, each checked: it names the user, has the right
   * usage and one key, and the self-signing and user-signing keys carry the master key's
   * signature. Keys that fail are dropped (and with a bad master key, all of them).
   */
  private crossSigningKeys(userId: string, res: KeysQueryResponse): CrossSigningKeys {
    const valid = (k: CrossSigningKey | undefined, usage: string) =>
      k &&
      typeof k === "object" &&
      k.user_id === userId &&
      Array.isArray(k.usage) &&
      k.usage.includes(usage) &&
      publicKeyOf(k) !== undefined
        ? k
        : undefined;
    const master = valid(res.master_keys?.[userId], "master");
    if (!master) return {};
    const mpk = publicKeyOf(master)!;
    const signedByMaster = (k: CrossSigningKey | undefined) =>
      k && verifyObject(this.protocol, k as unknown as Record<string, unknown>, userId, mpk, mpk) ? k : undefined;
    return {
      master,
      selfSigning: signedByMaster(valid(res.self_signing_keys?.[userId], "self_signing")),
      userSigning: signedByMaster(valid(res.user_signing_keys?.[userId], "user_signing")),
    };
  }

  /**
   * The users whose devices changed between two sync tokens (GET /keys/changes): they are marked
   * outdated, and their keys queried again before we next encrypt for them. For a client that
   * resumes from an older token than its device lists were last updated at.
   */
  async changesBetween(from: string, to: string): Promise<{ changed: string[]; left: string[] }> {
    const res = await this.api.endpoint("GET /v3/keys/changes", {}, { query: { from, to } });
    const lists = { changed: res.changed ?? [], left: res.left ?? [] };
    await this.store.transaction((tx) => this.handleDeviceLists(tx, lists));
    return lists;
  }

  /** Change what this device trusts about a user (the record is created if the user is not known yet). */
  async updateTrust(userId: string, change: (trust: UserTrustRecord) => UserTrustRecord): Promise<void> {
    await this.store.transaction(async (tx) => {
      const rec = (await tx.get<UserDevicesRecord>("devices", deviceKey(userId))) ?? { devices: {}, tracked: false, outdated: 1 };
      tx.put("devices", deviceKey(userId), { ...rec, trust: change({ ...rec.trust }) });
    });
  }

  private validate(userId: string, deviceId: string, keys: any): DeviceInfo | undefined {
    if (typeof keys !== "object" || keys === null || keys.user_id !== userId || keys.device_id !== deviceId) {
      this.logger.warn("device keys name another user or device", { userId, deviceId });
      return undefined;
    }
    const ed25519 = keys.keys?.[`ed25519:${deviceId}`];
    const curve25519 = keys.keys?.[`curve25519:${deviceId}`];
    if (typeof ed25519 !== "string" || typeof curve25519 !== "string") return undefined;
    if (!verifyObject(this.protocol, keys, userId, deviceId, ed25519)) {
      this.logger.warn("device keys have no valid self-signature", { userId, deviceId });
      return undefined;
    }
    const displayName = keys.unsigned?.device_display_name;
    const { unsigned: _unsigned, ...signed } = keys;
    return {
      signed,
      userId,
      deviceId,
      curve25519,
      ed25519,
      algorithms: Array.isArray(keys.algorithms) ? keys.algorithms.filter((a: unknown) => typeof a === "string") : [],
      displayName: typeof displayName === "string" ? displayName : undefined,
    };
  }
}

/** The one Ed25519 public key of a cross-signing key object. */
export function publicKeyOf(key: CrossSigningKey): string | undefined {
  const entries = Object.entries(key.keys ?? {});
  if (entries.length !== 1) return undefined;
  const [id, value] = entries[0];
  // The key ID is the public key itself ("ed25519:<unpadded base64 key>").
  return id === `ed25519:${value}` && typeof value === "string" ? value : undefined;
}
