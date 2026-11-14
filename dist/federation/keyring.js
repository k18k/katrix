import { isObject } from "../packages/shared/src/json.js";
import { publicKeyFromBase64, verifyJsonSignature } from "../core/crypto.js";
import { createPublicKey } from "node:crypto";
// src/federation/keyring.ts
/**
* Remote server signing keys. Keys are fetched directly from the server
* (`/_matrix/key/v2/server`), verified against their self-signature, cached in
* memory and persisted in the database.
*/
var KeyRing = class {
	hs;
	cache = /* @__PURE__ */ new Map();
	inflight = /* @__PURE__ */ new Map();
	constructor(hs) {
		this.hs = hs;
	}
	/** Get a verify key, fetching the server's keys when unknown or expired (as of `minValidUntil`). */
	async getKey(serverName, keyId, minValidUntil = Date.now()) {
		if (serverName === this.hs.serverName) return keyId === `ed25519:${this.hs.signingKey.keyId}` ? createPublicKey(this.hs.signingKey.privateKey) : null;
		const cached = this.cache.get(serverName)?.get(keyId);
		if (cached && cached.validUntil >= minValidUntil) return cached.key;
		if (!cached) {
			const row = await this.hs.db.findOne("remote_server_keys", [{
				field: "server_name",
				value: serverName
			}, {
				field: "key_id",
				value: keyId
			}]);
			if (row) {
				this.remember(serverName, keyId, row.key, row.valid_until_ts);
				if (row.valid_until_ts >= minValidUntil) return this.cache.get(serverName).get(keyId).key;
			}
		}
		await this.fetchKeys(serverName);
		const fetched = this.cache.get(serverName)?.get(keyId);
		return fetched && fetched.validUntil >= minValidUntil ? fetched.key : null;
	}
	remember(serverName, keyId, key, validUntil) {
		let m = this.cache.get(serverName);
		if (!m) this.cache.set(serverName, m = /* @__PURE__ */ new Map());
		m.set(keyId, {
			key: publicKeyFromBase64(key),
			validUntil
		});
	}
	fetchKeys(serverName) {
		let p = this.inflight.get(serverName);
		if (!p) {
			p = this.doFetch(serverName).finally(() => this.inflight.delete(serverName));
			this.inflight.set(serverName, p);
		}
		return p;
	}
	async doFetch(serverName) {
		try {
			const body = await this.hs.federation.client.request(serverName, "GET", "/_matrix/key/v2/server", { signed: false });
			await this.ingestServerKeys(serverName, body);
		} catch (err) {
			this.hs.logger.debug("Fetching keys for", serverName, "failed", err);
		}
	}
	/** Validate and store a `/_matrix/key/v2/server` response; resolves whether it was accepted. */
	async ingestServerKeys(serverName, body) {
		if (body.server_name !== serverName || !isObject(body.verify_keys)) return false;
		const current = Object.entries(body.verify_keys);
		if (current.length === 0) return false;
		const validUntil = Number(body.valid_until_ts) || 0;
		const entries = [];
		for (const [keyId, v] of current) {
			if (!isObject(v) || typeof v.key !== "string" || !signedWith(body, serverName, keyId, v.key)) return false;
			entries.push([
				keyId,
				v.key,
				validUntil
			]);
		}
		for (const [keyId, v] of Object.entries(isObject(body.old_verify_keys) ? body.old_verify_keys : {})) if (isObject(v) && typeof v.key === "string") entries.push([
			keyId,
			v.key,
			Number(v.expired_ts) || 0
		]);
		for (const [keyId, key, until] of entries) {
			this.remember(serverName, keyId, key, until);
			await this.hs.db.upsert("remote_server_keys", {
				server_name: serverName,
				key_id: keyId,
				key,
				valid_until_ts: until
			});
		}
		return true;
	}
	/** Verify that `obj` carries a valid signature from `serverName`. */
	async verifySignedBy(obj, serverName, minValidUntil) {
		const { signatures } = { ...obj };
		const sigs = isObject(signatures) ? signatures[serverName] : void 0;
		if (!isObject(sigs)) return false;
		for (const keyId of Object.keys(sigs)) {
			if (!keyId.startsWith("ed25519:")) continue;
			const key = await this.getKey(serverName, keyId, minValidUntil);
			if (key && verifyJsonSignature(obj, serverName, keyId, key)) return true;
		}
		return false;
	}
	/** Cached keys in `/_matrix/key/v2/query` format (we act as a basic notary for keys we know). */
	async knownKeys(serverName) {
		const rows = await this.hs.db.findMany("remote_server_keys", { where: [{
			field: "server_name",
			value: serverName
		}] });
		if (!rows.length) return [];
		const verify_keys = {};
		let until = 0;
		for (const r of rows) {
			verify_keys[r.key_id] = { key: r.key };
			until = Math.max(until, r.valid_until_ts);
		}
		return [{
			server_name: serverName,
			valid_until_ts: until,
			verify_keys,
			old_verify_keys: {}
		}];
	}
};
/** Whether `body` carries a valid signature by the key `keyId` of `serverName`, given as base64; false for a malformed key. */
function signedWith(body, serverName, keyId, key) {
	try {
		return verifyJsonSignature(body, serverName, keyId, publicKeyFromBase64(key));
	} catch {
		return false;
	}
}
export { KeyRing };

//# sourceMappingURL=keyring.js.map