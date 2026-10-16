import { errors } from "#core/errors.ts";
import { isObject } from "#core/json.ts";
import type { Homeserver } from "#homeserver.ts";
import type { FindManyOptions, Row } from "#storage/types.ts";
import { UNSTABLE } from "#core/m.ts";

/** End-to-end encryption key storage (device keys, one-time keys, cross-signing). */
export class KeyService {
  private hs: Homeserver;

  constructor(hs: Homeserver) {
    this.hs = hs;
  }

  /** A local user's devices or device keys changed: update local clients and remote servers. */
  async deviceChanged(userId: string, deletedDeviceId?: string): Promise<void> {
    await this.markDeviceListChanged(userId);
    await this.hs.federation.onDeviceListChange(userId, deletedDeviceId).catch((err) => this.hs.logger.warn("Device list EDU failed", err));
  }

  async markDeviceListChanged(userId: string, notify = true): Promise<void> {
    await this.hs.streams.write((stream) => this.hs.db.upsert("device_list_changes", { user_id: userId, stream }));
    if (notify) this.hs.notifier.notify(await this.hs.rooms.usersSharingRooms(userId));
  }

  /**
   * A partial-state room got its full state (MSC3902): device list updates received meanwhile for
   * users we could not place count as changes now, if those users turned out to be members.
   */
  async onPartialStateComplete(roomId: string, pendingUsers: string[]): Promise<void> {
    const members = new Set(await this.hs.rooms.joinedMembers(roomId));
    for (const userId of pendingUsers) {
      if (members.has(userId)) await this.markDeviceListChanged(userId, false);
    }
    this.hs.notifier.notify([...members].filter((u) => this.hs.isLocalUser(u)));
  }

  async upload(userId: string, deviceId: string, body: Record<string, any>): Promise<Record<string, number>> {
    if (body.device_keys !== undefined) {
      const dk = body.device_keys;
      if (!isObject(dk) || dk.user_id !== userId || dk.device_id !== deviceId)
        throw errors.invalidParam("device_keys do not match this device");
      if (!Array.isArray(dk.algorithms) || !isObject(dk.keys) || !isObject(dk.signatures)) {
        throw errors.badJson("device_keys must contain algorithms, keys and signatures");
      }
      const existing = await this.hs.db.findOne("device_keys", [
        { field: "user_id", value: userId },
        { field: "device_id", value: deviceId },
      ]);
      if (!existing || JSON.stringify(existing.keys) !== JSON.stringify(dk)) {
        await this.hs.streams.write((stream) =>
          this.hs.db.upsert("device_keys", { user_id: userId, device_id: deviceId, keys: dk, stream }),
        );
        await this.deviceChanged(userId);
      }
    }
    const device = [
      { field: "user_id", value: userId },
      { field: "device_id", value: deviceId },
    ];
    if (isObject(body.one_time_keys)) {
      for (const [fullId, key] of Object.entries(body.one_time_keys)) {
        const [algorithm] = fullId.split(":");
        const existing = await this.hs.db.findOne("one_time_keys", [...device, { field: "key_id", value: fullId }]);
        if (existing) {
          if (JSON.stringify(existing.key) !== JSON.stringify(key)) throw errors.invalidParam(`One time key ${fullId} already exists`);
          continue;
        }
        await this.hs.streams.write((seq) =>
          this.hs.db.create("one_time_keys", {
            user_id: userId,
            device_id: deviceId,
            key_id: fullId,
            algorithm,
            key,
            fallback: false,
            used: false,
            seq,
          }),
        );
      }
    }
    // Uploading a fallback key replaces the previous one of the same algorithm.
    const fallbackKeys = body.fallback_keys ?? body[UNSTABLE.ORG.MATRIX.MSC2732.FALLBACK_KEYS];
    if (isObject(fallbackKeys)) {
      for (const [fullId, key] of Object.entries(fallbackKeys)) {
        const [algorithm] = fullId.split(":");
        const existing = await this.hs.db.findOne("fallback_keys", [...device, { field: "algorithm", value: algorithm }]);
        // Re-uploading the current key keeps its "used" flag.
        if (existing && existing.key_id === fullId && JSON.stringify(existing.key) === JSON.stringify(key)) continue;
        await this.hs.db.upsert("fallback_keys", { user_id: userId, device_id: deviceId, algorithm, key_id: fullId, key, used: false });
      }
    }
    return this.oneTimeKeyCounts(userId, deviceId);
  }

  async oneTimeKeyCounts(userId: string, deviceId: string): Promise<Record<string, number>> {
    const rows = await this.hs.db.findMany("one_time_keys", {
      where: [
        { field: "user_id", value: userId },
        { field: "device_id", value: deviceId },
        { field: "fallback", value: false },
      ],
      // Counted on every /sync: only the algorithm, not the keys.
      fields: ["algorithm"],
    });
    const counts: Record<string, number> = { signed_curve25519: 0 };
    for (const r of rows) counts[r.algorithm] = (counts[r.algorithm] ?? 0) + 1;
    return counts;
  }

  async unusedFallbackKeyTypes(userId: string, deviceId: string): Promise<string[]> {
    const rows = await this.hs.db.findMany("fallback_keys", {
      where: [
        { field: "user_id", value: userId },
        { field: "device_id", value: deviceId },
        { field: "used", value: false },
      ],
      fields: ["algorithm"],
    });
    return [...new Set(rows.map((r) => r.algorithm))];
  }

  async query(requester: string, deviceKeys: Record<string, string[]>, timeoutMs = 10_000): Promise<Record<string, any>> {
    const result: Record<string, any> = { device_keys: {}, failures: {}, master_keys: {}, self_signing_keys: {}, user_signing_keys: {} };
    const remote: Record<string, string[]> = {};
    for (const [userId, devices] of Object.entries(deviceKeys ?? {})) {
      if (!this.hs.isLocalUser(userId)) {
        remote[userId] = devices;
        continue;
      }
      const rows = await this.hs.db.findMany("device_keys", { where: [{ field: "user_id", value: userId }] });
      const deviceRows = await this.hs.db.findMany("devices", { where: [{ field: "user_id", value: userId }] });
      const names = new Map(deviceRows.map((d) => [d.device_id, d.display_name]));
      const wanted = Array.isArray(devices) && devices.length ? new Set(devices) : null;
      const out: Record<string, any> = {};
      for (const row of rows) {
        if (wanted && !wanted.has(row.device_id)) continue;
        if (!names.has(row.device_id)) continue;
        const keys = await this.withSignatures(userId, `${row.device_id}`, row.keys);
        const name = names.get(row.device_id);
        keys.unsigned = { ...keys.unsigned, ...(name ? { device_display_name: name } : {}) };
        out[row.device_id] = keys;
      }
      result.device_keys[userId] = out;
      const csRows = await this.hs.db.findMany("cross_signing_keys", { where: [{ field: "user_id", value: userId }] });
      for (const cs of csRows) {
        if (cs.key_type === "user_signing" && userId !== requester) continue;
        const pub = Object.values(cs.key.keys ?? {})[0] as string;
        result[`${cs.key_type}_keys`][userId] = await this.withSignatures(userId, pub, cs.key);
      }
    }
    if (Object.keys(remote).length && requester) {
      // Device lists of users sharing a room with us are cached and kept fresh by
      // m.device_list_update; everyone else's are fetched every time.
      const fetch: Record<string, string[]> = {};
      const tracked = new Set<string>();
      for (const [userId, devices] of Object.entries(remote)) {
        if (!(await this.isTracked(userId))) {
          await this.dropRemoteCache(userId);
          fetch[userId] = devices;
          continue;
        }
        tracked.add(userId);
        const list = await this.hs.db.findOne("remote_device_lists", [{ field: "user_id", value: userId }]);
        if (!list || list.stale) {
          fetch[userId] = [];
          continue;
        }
        await this.fromRemoteCache(userId, devices, result);
      }
      if (Object.keys(fetch).length) {
        const { results, failures } = await this.hs.federation.queryKeys(fetch, timeoutMs);
        Object.assign(result.failures, failures);
        const fetched: Record<string, any> = { device_keys: {}, master_keys: {}, self_signing_keys: {} };
        for (const res of results) {
          for (const kind of ["device_keys", "master_keys", "self_signing_keys"]) {
            for (const [userId, value] of Object.entries(isObject(res[kind]) ? res[kind] : {})) {
              if (fetch[userId] !== undefined) fetched[kind][userId] = value;
            }
          }
        }
        for (const userId of Object.keys(fetch)) {
          if (tracked.has(userId) && isObject(fetched.device_keys[userId])) {
            await this.storeRemoteCache(
              userId,
              fetched.device_keys[userId],
              fetched.master_keys[userId],
              fetched.self_signing_keys[userId],
            );
            await this.fromRemoteCache(userId, remote[userId], result);
            continue;
          }
          for (const kind of ["device_keys", "master_keys", "self_signing_keys"]) {
            if (fetched[kind][userId] !== undefined) result[kind][userId] = fetched[kind][userId];
          }
        }
      }
    }
    return result;
  }

  /** Whether a remote user shares a room with a local user (by known membership). */
  async isTracked(userId: string): Promise<boolean> {
    const rows = await this.hs.db.findMany("memberships", {
      where: [
        { field: "user_id", value: userId },
        { field: "membership", value: "join" },
      ],
    });
    for (const row of rows) {
      if ((await this.hs.rooms.joinedMembers(row.room_id)).some((u) => this.hs.isLocalUser(u))) return true;
    }
    return false;
  }

  async dropRemoteCache(userId: string): Promise<void> {
    await this.hs.db.delete("remote_devices", [{ field: "user_id", value: userId }]);
    await this.hs.db.delete("remote_device_lists", [{ field: "user_id", value: userId }]);
  }

  /** A tracked user's device list changed: refetch it on the next query. */
  async markRemoteStale(userId: string): Promise<void> {
    if (await this.isTracked(userId)) {
      await this.hs.db.upsert("remote_device_lists", { user_id: userId, stream_id: 0, stale: true });
    } else {
      await this.dropRemoteCache(userId);
    }
  }

  private async storeRemoteCache(userId: string, devices: Record<string, any>, master?: unknown, selfSigning?: unknown): Promise<void> {
    await this.hs.db.delete("remote_devices", [{ field: "user_id", value: userId }]);
    for (const [deviceId, keys] of Object.entries(devices)) {
      if (!isObject(keys)) continue;
      const name = keys.unsigned?.device_display_name;
      await this.hs.db.upsert("remote_devices", {
        user_id: userId,
        device_id: deviceId,
        keys,
        display_name: typeof name === "string" ? name : null,
        stream_id: 0,
      });
    }
    for (const [type, key] of [
      ["master", master],
      ["self_signing", selfSigning],
    ] as const) {
      if (isObject(key))
        await this.hs.streams.write((stream) => this.hs.db.upsert("cross_signing_keys", { user_id: userId, key_type: type, key, stream }));
    }
    await this.hs.db.upsert("remote_device_lists", { user_id: userId, stream_id: 0, stale: false });
  }

  private async fromRemoteCache(userId: string, devices: string[], result: Record<string, any>): Promise<void> {
    const wanted = Array.isArray(devices) && devices.length ? new Set(devices) : null;
    const out: Record<string, any> = {};
    for (const row of await this.hs.db.findMany("remote_devices", { where: [{ field: "user_id", value: userId }] })) {
      if (!wanted || wanted.has(row.device_id)) out[row.device_id] = row.keys;
    }
    result.device_keys[userId] = out;
    for (const cs of await this.hs.db.findMany("cross_signing_keys", { where: [{ field: "user_id", value: userId }] })) {
      if (cs.key_type === "master" || cs.key_type === "self_signing") result[`${cs.key_type}_keys`][userId] = cs.key;
    }
  }

  private async withSignatures(userId: string, keyId: string, key: Record<string, any>): Promise<Record<string, any>> {
    const sigs = await this.hs.db.findMany("key_signatures", {
      where: [
        { field: "user_id", value: userId },
        { field: "key_id", value: keyId },
      ],
    });
    if (sigs.length === 0) return structuredClone(key);
    const out = structuredClone(key);
    out.signatures ??= {};
    for (const s of sigs) out.signatures[s.signer] = { ...out.signatures[s.signer], [s.signer_key_id]: s.signature };
    return out;
  }

  async claim(request: Record<string, Record<string, string>>): Promise<Record<string, any>> {
    const result: Record<string, any> = {};
    for (const [userId, devices] of Object.entries(request ?? {})) {
      for (const [deviceId, algorithm] of Object.entries(devices ?? {})) {
        const base = [
          { field: "user_id", value: userId },
          { field: "device_id", value: deviceId },
          { field: "algorithm", value: algorithm },
        ];
        // Keys are handed out in upload order (MSC4225).
        let key: Record<string, any> | null =
          (
            await this.hs.db.findMany("one_time_keys", {
              where: [...base, { field: "fallback", value: false }],
              sortBy: { field: "seq", direction: "asc" },
              limit: 1,
            })
          )[0] ?? null;
        if (key) {
          await this.hs.db.delete("one_time_keys", [...base, { field: "key_id", value: key.key_id }]);
        } else {
          key = await this.hs.db.findOne("fallback_keys", base);
          if (key && !key.used) await this.hs.db.update("fallback_keys", base, { used: true });
        }
        if (!key) continue;
        result[userId] ??= {};
        result[userId][deviceId] = { [key.key_id]: key.key };
      }
    }
    return result;
  }

  async uploadCrossSigning(userId: string, body: Record<string, any>): Promise<void> {
    for (const type of ["master", "self_signing", "user_signing"]) {
      const key = body[`${type}_key`];
      if (key === undefined) continue;
      if (!isObject(key) || key.user_id !== userId || !isObject(key.keys)) throw errors.invalidParam(`Invalid ${type}_key`);
      await this.hs.streams.write((stream) => this.hs.db.upsert("cross_signing_keys", { user_id: userId, key_type: type, key, stream }));
    }
    await this.markDeviceListChanged(userId);
    await this.hs.federation.onSigningKeyUpdate(userId).catch(() => {});
  }

  async uploadSignatures(signer: string, body: Record<string, any>): Promise<Record<string, any>> {
    const failures: Record<string, any> = {};
    const changed = new Set<string>();
    for (const [userId, keys] of Object.entries(body ?? {})) {
      if (!isObject(keys)) continue;
      for (const [keyId, signed] of Object.entries(keys)) {
        const sigs = (signed as any)?.signatures?.[signer];
        if (!isObject(sigs)) {
          failures[userId] = { ...failures[userId], [keyId]: { errcode: "M_INVALID_SIGNATURE", error: "No signature from signer" } };
          continue;
        }
        for (const [signerKeyId, signature] of Object.entries(sigs)) {
          await this.hs.db.upsert("key_signatures", {
            user_id: userId,
            key_id: keyId,
            signer,
            signer_key_id: signerKeyId,
            signature: String(signature),
          });
        }
        changed.add(userId);
      }
    }
    for (const u of changed) {
      if (this.hs.isLocalUser(u)) await this.deviceChanged(u);
      else await this.markDeviceListChanged(u);
    }
    if (changed.has(signer)) await this.hs.federation.onSigningKeyUpdate(signer).catch(() => {});
    return { failures };
  }

  /** Users (sharing a room with `userId`) whose device lists changed after `since`. */
  /**
   * Device-list changes for /sync and /keys/changes. /sync passes what it has already read (the
   * membership changes, the device-list rows, the user's joined rooms) to save the queries.
   */
  async changesSince(
    userId: string,
    since: number,
    upTo: number,
    known: { memberChanges?: Row[]; deviceRows?: Row[]; joinedRooms?: string[] } = {},
  ): Promise<{ changed: string[]; left: string[] }> {
    const sharing = await this.hs.rooms.usersSharingRooms(userId);
    const rows = known.deviceRows ?? (await this.hs.db.findMany("device_list_changes", deviceListChangesQuery(sharing, since)));
    const changed = new Set<string>();
    for (const r of rows) if (r.stream <= upTo && sharing.has(r.user_id)) changed.add(r.user_id);
    // Users we newly share a room with also count as changed.
    const left = new Set<string>();
    const memberRows = known.memberChanges ?? (await this.hs.rooms.membershipChangesSince(userId, since));
    const myRooms = new Set([
      ...(known.joinedRooms ?? (await this.hs.rooms.roomsForUser(userId))),
      ...memberRows.filter((m) => m.user_id === userId).map((m) => m.room_id),
    ]);
    for (const m of memberRows) {
      if (m.stream > upTo || !myRooms.has(m.room_id)) continue;
      if (m.user_id === userId) {
        const members = await this.hs.rooms.joinedMembers(m.room_id);
        if (m.membership === "join") {
          for (const u of members) if (u !== userId) changed.add(u);
        } else {
          for (const u of members) if (!sharing.has(u)) left.add(u);
        }
      } else if (m.membership === "join") {
        changed.add(m.user_id);
      } else if (!sharing.has(m.user_id)) {
        left.add(m.user_id);
      }
    }
    for (const u of left) changed.delete(u);
    return { changed: [...changed], left: [...left] };
  }
}

/**
 * The device-list changes after `since` of the users sharing a room with someone.
 * https://github.com/k18k/matrix-nodejs-homeserver/issues/31: this read every device-list change
 * on the server since `since`; it asks for the users sharing a room only (up to a size where an IN
 * list stays reasonable for the database).
 */
export function deviceListChangesQuery(sharing: Set<string>, since: number): FindManyOptions {
  return {
    where: [
      { field: "stream", operator: "gt", value: since },
      ...(sharing.size <= 5000 ? [{ field: "user_id", operator: "in" as const, value: [...sharing] }] : []),
    ],
  };
}
