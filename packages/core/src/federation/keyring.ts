import { createPublicKey, type KeyObject } from "node:crypto";
import { publicKeyFromBase64, verifyJsonSignature } from "#core/crypto.ts";
import { isObject } from "#core/json.ts";
import type { Homeserver } from "#homeserver.ts";

interface CachedKey {
  key: KeyObject;
  validUntil: number;
}

/**
 * Remote server signing keys. Keys are fetched directly from the server
 * (`/_matrix/key/v2/server`), verified against their self-signature, cached in
 * memory and persisted in the database.
 */
export class KeyRing {
  private hs: Homeserver;
  private cache = new Map<string, Map<string, CachedKey>>();
  private inflight = new Map<string, Promise<void>>();

  constructor(hs: Homeserver) {
    this.hs = hs;
  }

  /** Get a verify key, fetching the server's keys when unknown or expired (as of `minValidUntil`). */
  async getKey(serverName: string, keyId: string, minValidUntil = Date.now()): Promise<KeyObject | null> {
    if (serverName === this.hs.serverName) {
      return keyId === `ed25519:${this.hs.signingKey.keyId}` ? createPublicKey(this.hs.signingKey.privateKey) : null;
    }
    const cached = this.cache.get(serverName)?.get(keyId);
    if (cached && cached.validUntil >= minValidUntil) return cached.key;
    if (!cached) {
      const row = await this.hs.db.findOne("remote_server_keys", [
        { field: "server_name", value: serverName },
        { field: "key_id", value: keyId },
      ]);
      if (row) {
        this.remember(serverName, keyId, row.key, row.valid_until_ts);
        if (row.valid_until_ts >= minValidUntil) return this.cache.get(serverName)!.get(keyId)!.key;
      }
    }
    await this.fetchKeys(serverName);
    const fetched = this.cache.get(serverName)?.get(keyId);
    // Expired keys are still accepted for events created while they were valid.
    return fetched ? fetched.key : null;
  }

  private remember(serverName: string, keyId: string, key: string, validUntil: number): void {
    let m = this.cache.get(serverName);
    if (!m) this.cache.set(serverName, (m = new Map()));
    m.set(keyId, { key: publicKeyFromBase64(key), validUntil });
  }

  private fetchKeys(serverName: string): Promise<void> {
    let p = this.inflight.get(serverName);
    if (!p) {
      p = this.doFetch(serverName).finally(() => this.inflight.delete(serverName));
      this.inflight.set(serverName, p);
    }
    return p;
  }

  private async doFetch(serverName: string): Promise<void> {
    try {
      const body = await this.hs.federation.client.request(serverName, "GET", "/_matrix/key/v2/server", { signed: false });
      await this.ingestServerKeys(serverName, body);
    } catch (err) {
      this.hs.logger.debug("Fetching keys for", serverName, "failed", err);
    }
  }

  /** Validate and store a `/_matrix/key/v2/server` response. */
  async ingestServerKeys(serverName: string, body: Record<string, any>): Promise<void> {
    if (body.server_name !== serverName || !isObject(body.verify_keys)) return;
    const validUntil = Number(body.valid_until_ts) || 0;
    const entries: [string, string, number][] = [];
    for (const [keyId, v] of Object.entries(body.verify_keys))
      if (typeof (v as any)?.key === "string") entries.push([keyId, (v as any).key, validUntil]);
    for (const [keyId, v] of Object.entries(isObject(body.old_verify_keys) ? body.old_verify_keys : {})) {
      if (typeof (v as any)?.key === "string") entries.push([keyId, (v as any).key, Number((v as any).expired_ts) || 0]);
    }
    // The response must be signed by each of its current keys.
    for (const [keyId, key] of entries.filter(([id]) => id in body.verify_keys)) {
      if (!verifyJsonSignature(body, serverName, keyId, publicKeyFromBase64(key))) return;
    }
    for (const [keyId, key, until] of entries) {
      this.remember(serverName, keyId, key, until);
      await this.hs.db.upsert("remote_server_keys", { server_name: serverName, key_id: keyId, key, valid_until_ts: until });
    }
  }

  /** Verify that `obj` carries a valid signature from `serverName`. */
  async verifySignedBy(obj: Record<string, any>, serverName: string, minValidUntil?: number): Promise<boolean> {
    const sigs = obj.signatures?.[serverName];
    if (!isObject(sigs)) return false;
    for (const keyId of Object.keys(sigs)) {
      if (!keyId.startsWith("ed25519:")) continue;
      const key = await this.getKey(serverName, keyId, minValidUntil);
      if (key && verifyJsonSignature(obj, serverName, keyId, key)) return true;
    }
    return false;
  }

  /** Cached keys in `/_matrix/key/v2/query` format (we act as a basic notary for keys we know). */
  async knownKeys(serverName: string): Promise<Record<string, any>[]> {
    const rows = await this.hs.db.findMany("remote_server_keys", { where: [{ field: "server_name", value: serverName }] });
    if (!rows.length) return [];
    const verify_keys: Record<string, any> = {};
    let until = 0;
    for (const r of rows) {
      verify_keys[r.key_id] = { key: r.key };
      until = Math.max(until, r.valid_until_ts);
    }
    return [{ server_name: serverName, valid_until_ts: until, verify_keys, old_verify_keys: {} }];
  }
}
