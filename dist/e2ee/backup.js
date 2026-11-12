import { MatrixError } from "../http/errors.js";
import { describeError } from "../util/logger.js";
import { decodeBase64, encodeBase64 } from "../shared/base64.js";
import { constantTimeEqual } from "../shared/bytes.js";
import { signingJson } from "../shared/canonical-json.js";
import { decodeUtf8, encodeUtf8 } from "../shared/utf8.js";
import { Mutex } from "../util/mutex.js";
import { inboundKey } from "./crypto-store.js";
import { MEGOLM_ALGORITHM, verifyObject } from "./keys.js";
// src/e2ee/backup.ts
const BACKUP_ALGORITHM = "m.megolm_backup.v1.curve25519-aes-sha2";
const ZERO_SALT = /* @__PURE__ */ new Uint8Array(32);
const EMPTY = /* @__PURE__ */ new Uint8Array(0);
function backupKeys(primitives, sharedSecret) {
	const okm = primitives.hkdfSha256(sharedSecret, ZERO_SALT, EMPTY, 80);
	return {
		aes: okm.subarray(0, 32),
		mac: okm.subarray(32, 64),
		iv: okm.subarray(64, 80)
	};
}
/**
* Encrypt a session for m.megolm_backup.v1.curve25519-aes-sha2, by the spec's steps: an ephemeral
* X25519 key agreement with the backup key, HKDF-SHA-256 into AES-256-CBC key, MAC key and IV.
* The MAC is of the empty string, not the ciphertext: a bug in libolm every implementation now
* shares (the spec's warning, MSC4048), so it only shows that the keys were derived right.
*/
function encryptBackupSession(primitives, backupPublicKey, session) {
	const ephemeral = primitives.x25519GenerateKeyPair();
	const k = backupKeys(primitives, primitives.x25519SharedSecret(ephemeral.secretKey, backupPublicKey));
	const ciphertext = primitives.aes256CbcEncrypt(k.aes, k.iv, encodeUtf8(JSON.stringify(session)));
	return {
		ephemeral: encodeBase64(ephemeral.publicKey),
		ciphertext: encodeBase64(ciphertext),
		mac: encodeBase64(primitives.hmacSha256(k.mac, EMPTY).subarray(0, 8))
	};
}
function decryptBackupSession(primitives, backupPrivateKey, data) {
	const k = backupKeys(primitives, primitives.x25519SharedSecret(backupPrivateKey, decodeBase64(data.ephemeral)));
	if (!constantTimeEqual(primitives.hmacSha256(k.mac, EMPTY).subarray(0, 8), decodeBase64(data.mac))) throw new Error("The backed-up session does not decrypt with this key");
	const session = JSON.parse(decodeUtf8(primitives.aes256CbcDecrypt(k.aes, k.iv, decodeBase64(data.ciphertext))));
	if (typeof session?.session_key !== "string" || typeof session.sender_key !== "string") throw new Error("The backed-up session is malformed");
	return session;
}
const STORE_KEY = "key_backup";
/**
* Server-side key backup (https://spec.matrix.org/v1.19/client-server-api/#server-side-key-backups):
* room keys are uploaded encrypted to a public key whose private half only the user has (in
* secret storage, or shared from another device), so a new device can read old messages.
*
* Keys are only uploaded to a backup whose auth_data is trusted: signed by the user's master key
* or one of their verified devices, or whose private key this device holds.
*/
var KeyBackup = class {
	api;
	store;
	primitives;
	protocol;
	pickler;
	devices;
	crossSigning;
	box;
	logger;
	userId;
	signWithDevice;
	uploadMutex = new Mutex();
	constructor(opts) {
		this.api = opts.api;
		this.store = opts.store;
		this.primitives = opts.primitives;
		this.protocol = opts.protocol;
		this.pickler = opts.pickler;
		this.devices = opts.devices;
		this.crossSigning = opts.crossSigning;
		this.box = opts.box;
		this.logger = opts.logger;
		this.userId = opts.userId;
		this.signWithDevice = opts.signWithDevice;
	}
	/** The server's current backup, if there is one. */
	async serverInfo() {
		try {
			return await this.api.endpoint("GET /v3/room_keys/version", {}, {});
		} catch (e) {
			if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return void 0;
			throw e;
		}
	}
	/** The backup this device uploads to, if any. */
	async active() {
		const s = await this.store.get("account", STORE_KEY);
		return s ? {
			version: s.version,
			publicKey: s.publicKey,
			hasPrivateKey: s.privateKey !== void 0
		} : void 0;
	}
	/** The backup's private key, if this device has it (to put it in secret storage). */
	async privateKey() {
		const s = await this.store.get("account", STORE_KEY);
		return s?.privateKey ? this.box.open("m.megolm_backup.v1", s.privateKey) : void 0;
	}
	/**
	* Create a new backup (the server's current one is replaced as the place keys go) and start
	* uploading every room key to it. Its auth_data is signed by this device, and by the master
	* key when given. Records the user's choice in m.key_backup (v1.19). Resolves with the
	* private key, for the app to put in secret storage.
	*/
	async create(opts = {}) {
		const pair = this.primitives.x25519GenerateKeyPair();
		let authData = { public_key: encodeBase64(pair.publicKey) };
		authData = await this.signWithDevice(authData);
		if (opts.masterKey) {
			const mpk = encodeBase64(this.primitives.ed25519PublicKey(opts.masterKey));
			const sig = encodeBase64(this.primitives.ed25519Sign(opts.masterKey, encodeUtf8(signingJson(authData))));
			authData = {
				...authData,
				signatures: {
					...authData.signatures,
					[this.userId]: {
						...authData.signatures?.[this.userId],
						[`ed25519:${mpk}`]: sig
					}
				}
			};
		}
		const { version } = await this.api.endpoint("POST /v3/room_keys/version", {}, { body: {
			algorithm: BACKUP_ALGORITHM,
			auth_data: authData
		} });
		await this.activate(version, pair.publicKey, pair.secretKey);
		await this.api.endpoint("PUT /v3/user/:userId/account_data/:type", {
			userId: this.userId,
			type: "m.key_backup"
		}, { body: { enabled: true } }).catch((e) => this.logger.warn("could not record m.key_backup", describeError(e)));
		return {
			version,
			privateKey: pair.secretKey
		};
	}
	/**
	* Use the server's current backup with its private key (from secret storage, secret sharing,
	* or typed in by the user). The key must match the backup's public key.
	*/
	async enableWithPrivateKey(privateKey) {
		const info = await this.serverInfo();
		if (!info || info.algorithm !== "m.megolm_backup.v1.curve25519-aes-sha2") throw new Error("There is no supported key backup on the server");
		const publicKey = this.primitives.x25519PublicKey(privateKey);
		if (encodeBase64(publicKey) !== info.auth_data.public_key?.replace(/=+$/, "")) throw new Error("The key does not belong to the current backup");
		await this.activate(info.version, publicKey, privateKey);
		return info.version;
	}
	/** Upload to the server's current backup without its private key, if its auth_data is trusted. Resolves whether it is. */
	async enableIfTrusted() {
		const info = await this.serverInfo();
		if (!info || info.algorithm !== "m.megolm_backup.v1.curve25519-aes-sha2" || !await this.isTrusted(info)) return false;
		await this.activate(info.version, decodeBase64(info.auth_data.public_key), void 0);
		return true;
	}
	async activate(version, publicKey, privateKey) {
		await this.store.transaction(async (tx) => {
			const previous = await tx.get("account", STORE_KEY);
			tx.put("account", STORE_KEY, {
				version,
				publicKey: encodeBase64(publicKey),
				privateKey: privateKey ? this.box.seal("m.megolm_backup.v1", privateKey) : previous?.version === version ? previous.privateKey : void 0
			});
		});
	}
	/** Stop uploading (the backup stays on the server). */
	async disable() {
		await this.store.transaction(async (tx) => tx.delete("account", STORE_KEY));
	}
	/** Delete a backup version on the server (and stop using it here, if it was the active one). */
	async deleteVersion(version) {
		await this.api.endpoint("DELETE /v3/room_keys/version/:version", { version }, {});
		if ((await this.active())?.version === version) await this.disable();
	}
	/**
	* Whether a backup's auth_data is trusted: signed by our trusted master key or by one of our
	* verified devices (spec: "Clients must only store keys in backups after they have ensured
	* that the auth_data is trusted").
	*/
	async isTrusted(info) {
		const authData = info.auth_data;
		const sigs = info.auth_data.signatures?.[this.userId] ?? {};
		const own = await this.devices.getUser(this.userId);
		const masterKey = await this.crossSigning.masterKey(this.userId);
		if (masterKey && (await this.crossSigning.userTrust(this.userId)).verified && verifyObject(this.protocol, authData, this.userId, masterKey, masterKey)) return true;
		for (const keyId of Object.keys(sigs)) {
			const deviceId = keyId.slice(8);
			const device = own?.devices[deviceId];
			if (!device || !(await this.crossSigning.deviceTrust(this.userId, deviceId)).verified) continue;
			if (verifyObject(this.protocol, authData, this.userId, deviceId, device.ed25519)) return true;
		}
		const active = await this.active();
		return active?.hasPrivateKey === true && active.publicKey === info.auth_data.public_key?.replace(/=+$/, "");
	}
	/**
	* Upload the room keys not yet in the active backup, in batches. A backup replaced on the
	* server (M_WRONG_ROOM_KEYS_VERSION) stops the uploads until the app enables the new one.
	*/
	backupPending() {
		return this.uploadMutex.run(async () => {
			const active = await this.store.get("account", STORE_KEY);
			if (!active) return 0;
			const publicKey = decodeBase64(active.publicKey);
			let uploaded = 0;
			for (;;) {
				const pending = (await this.store.list("inbound_group_sessions")).filter(([, r]) => r.backedUpTo !== active.version).slice(0, 200);
				if (pending.length === 0) return uploaded;
				const rooms = {};
				for (const [, record] of pending) {
					const data = await this.sessionData(record, publicKey);
					if (!data) continue;
					(rooms[record.roomId] ??= { sessions: {} }).sessions[record.sessionId] = data;
				}
				try {
					await this.upload(active.version, rooms);
				} catch (e) {
					if (e instanceof MatrixError && e.errcode === "M_WRONG_ROOM_KEYS_VERSION") {
						this.logger.warn("the key backup was replaced on the server; stopping uploads", { version: active.version });
						await this.disable();
						return uploaded;
					}
					throw e;
				}
				await this.store.transaction(async (tx) => {
					for (const [key] of pending) {
						const current = await tx.get("inbound_group_sessions", key);
						if (current) tx.put("inbound_group_sessions", key, {
							...current,
							backedUpTo: active.version
						});
					}
				});
				uploaded += pending.length;
			}
		});
	}
	/** One session or one room goes to its own endpoint (a smaller request); more go to PUT /room_keys/keys. */
	async upload(version, rooms) {
		const query = { version };
		const roomIds = Object.keys(rooms);
		if (roomIds.length === 1) {
			const [roomId] = roomIds;
			const sessions = rooms[roomId].sessions;
			const ids = Object.keys(sessions);
			if (ids.length === 1) {
				await this.api.endpoint("PUT /v3/room_keys/keys/:roomId/:sessionId", {
					roomId,
					sessionId: ids[0]
				}, {
					query,
					body: sessions[ids[0]]
				});
				return;
			}
			await this.api.endpoint("PUT /v3/room_keys/keys/:roomId", { roomId }, {
				query,
				body: { sessions }
			});
			return;
		}
		if (roomIds.length > 0) await this.api.endpoint("PUT /v3/room_keys/keys", {}, {
			query,
			body: { rooms }
		});
	}
	/** One backup version's information. */
	async versionInfo(version) {
		try {
			return await this.api.endpoint("GET /v3/room_keys/version/:version", { version }, {});
		} catch (e) {
			if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return void 0;
			throw e;
		}
	}
	/**
	* Add the master key's signature to the current backup's auth_data (after cross-signing was
	* set up or reset, so other devices trust the backup through the identity).
	*/
	async signWithMasterKey(masterKey) {
		const active = await this.active();
		const info = active ? await this.versionInfo(active.version) : void 0;
		if (!info) throw new Error("No active key backup");
		const mpk = encodeBase64(this.primitives.ed25519PublicKey(masterKey));
		const { signatures, ...unsigned } = info.auth_data;
		const sig = encodeBase64(this.primitives.ed25519Sign(masterKey, encodeUtf8(signingJson(unsigned))));
		const authData = {
			...info.auth_data,
			signatures: {
				...signatures,
				[this.userId]: {
					...signatures?.[this.userId],
					[`ed25519:${mpk}`]: sig
				}
			}
		};
		await this.api.endpoint("PUT /v3/room_keys/version/:version", { version: info.version }, { body: {
			algorithm: info.algorithm,
			auth_data: authData,
			version: info.version
		} });
	}
	/** Delete backed-up keys on the server: all of them, one room's, or one session. */
	async deleteKeys(opts = {}) {
		const version = (await this.active())?.version ?? (await this.serverInfo())?.version;
		if (!version) return;
		const query = { version };
		if (opts.roomId && opts.sessionId) await this.api.endpoint("DELETE /v3/room_keys/keys/:roomId/:sessionId", {
			roomId: opts.roomId,
			sessionId: opts.sessionId
		}, { query });
		else if (opts.roomId) await this.api.endpoint("DELETE /v3/room_keys/keys/:roomId", { roomId: opts.roomId }, { query });
		else await this.api.endpoint("DELETE /v3/room_keys/keys", {}, { query });
	}
	async sessionData(record, publicKey) {
		const session = this.pickler.inbound(record);
		const exported = session.exportAt(session.firstKnownIndex());
		if (!exported) return void 0;
		const chain = record.forwardingChain ?? [];
		const sender = await this.devices.deviceByCurveKey(record.senderUserId, record.senderKey);
		const verified = record.source === "own" || record.source === "m.room_key" && sender !== void 0 && (await this.crossSigning.deviceTrust(record.senderUserId, sender.deviceId)).verified;
		return {
			first_message_index: session.firstKnownIndex(),
			forwarded_count: chain.length,
			is_verified: verified,
			session_data: encryptBackupSession(this.primitives, publicKey, {
				algorithm: MEGOLM_ALGORITHM,
				forwarding_curve25519_key_chain: chain,
				sender_key: record.senderKey,
				sender_claimed_keys: record.claimedEd25519Key ? { ed25519: record.claimedEd25519Key } : {},
				session_key: exported
			})
		};
	}
	/**
	* Download and import keys from the server's backup (all, one room's, or one session), with
	* the private key given or the one this device has. Keys already known from an earlier index
	* are kept. Resolves with the sessions imported, for the client to retry decryption.
	*/
	async restore(opts = {}) {
		const info = await this.serverInfo();
		if (!info || info.algorithm !== "m.megolm_backup.v1.curve25519-aes-sha2") return [];
		const privateKey = opts.privateKey ?? await this.privateKey();
		if (!privateKey) throw new Error("No key backup private key: restore it from secret storage first");
		if (encodeBase64(this.primitives.x25519PublicKey(privateKey)) !== info.auth_data.public_key?.replace(/=+$/, "")) throw new Error("The key does not belong to the current backup");
		const query = { version: info.version };
		let rooms;
		if (opts.roomId && opts.sessionId) {
			const one = await this.api.endpoint("GET /v3/room_keys/keys/:roomId/:sessionId", {
				roomId: opts.roomId,
				sessionId: opts.sessionId
			}, { query }).catch((e) => {
				if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return void 0;
				throw e;
			});
			rooms = one ? { [opts.roomId]: { [opts.sessionId]: one } } : {};
		} else if (opts.roomId) rooms = { [opts.roomId]: (await this.api.endpoint("GET /v3/room_keys/keys/:roomId", { roomId: opts.roomId }, { query })).sessions ?? {} };
		else {
			const all = await this.api.endpoint("GET /v3/room_keys/keys", {}, { query });
			rooms = Object.fromEntries(Object.entries(all.rooms ?? {}).map(([r, v]) => [r, v.sessions ?? {}]));
		}
		const imported = [];
		await this.store.transaction(async (tx) => {
			for (const [roomId, sessions] of Object.entries(rooms)) for (const [sessionId, data] of Object.entries(sessions)) {
				let plain;
				let session;
				try {
					plain = decryptBackupSession(this.primitives, privateKey, data.session_data);
					if (plain.algorithm !== "m.megolm.v1.aes-sha2") continue;
					session = this.protocol.inboundGroupSessionFromExport(plain.session_key);
				} catch (e) {
					this.logger.warn("skipping a backed-up key that does not decrypt", {
						roomId,
						sessionId,
						...describeError(e)
					});
					continue;
				}
				if (session.sessionId() !== sessionId) continue;
				const key = inboundKey(roomId, sessionId);
				const existing = await tx.get("inbound_group_sessions", key);
				if (existing && session.compare(this.pickler.inbound(existing)) !== "better") continue;
				tx.put("inbound_group_sessions", key, {
					pickle: this.pickler.pickle(session),
					roomId,
					sessionId,
					senderKey: plain.sender_key,
					senderUserId: existing?.senderUserId ?? "",
					claimedEd25519Key: plain.sender_claimed_keys?.ed25519,
					firstKnownIndex: session.firstKnownIndex(),
					source: "backup",
					forwardingChain: Array.isArray(plain.forwarding_curve25519_key_chain) ? plain.forwarding_curve25519_key_chain : [],
					backedUpTo: info.version
				});
				imported.push({
					roomId,
					sessionId
				});
			}
		});
		return imported;
	}
};
export { BACKUP_ALGORITHM, KeyBackup, decryptBackupSession, encryptBackupSession };

//# sourceMappingURL=backup.js.map