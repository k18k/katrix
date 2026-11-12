import { describeError } from "../util/logger.js";
import { decodeUtf8, encodeUtf8 } from "../shared/utf8.js";
import { loadAccount, olmSessionKey, saveAccount } from "./crypto-store.js";
import { OLM_ALGORITHM, verifyObject } from "./keys.js";
import { ProtocolError } from "../protocol/protocol.js";
// src/e2ee/olm.ts
var OlmDecryptionError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.name = "OlmDecryptionError";
		this.code = code;
	}
};
/**
* Olm sessions with other devices (m.olm.v1.curve25519-aes-sha2,
* https://spec.matrix.org/v1.16/client-server-api/#molmv1curve25519-aes-sha2): encrypting
* to-device payloads, decrypting them, and starting sessions from claimed one-time keys.
*/
var OlmService = class OlmService {
	api;
	store;
	pickler;
	devices;
	logger;
	userId;
	deviceId;
	identity;
	constructor(opts) {
		this.api = opts.api;
		this.store = opts.store;
		this.pickler = opts.pickler;
		this.devices = opts.devices;
		this.logger = opts.logger;
		this.userId = opts.userId;
		this.deviceId = opts.deviceId;
	}
	setIdentity(identity) {
		this.identity = identity;
	}
	get identityKeys() {
		if (!this.identity) throw new Error("The crypto engine is not initialised");
		return this.identity;
	}
	async sessions(tx, senderKey) {
		return (await tx.list("olm_sessions", `${senderKey}|`)).map(([, r]) => r);
	}
	/**
	* The session to send with: the one we last received on (the spec asks clients to prefer it,
	* as it is the one the other side is sure to have), else the newest.
	*/
	static preferred(records) {
		return [...records].sort((a, b) => (b.lastReceivedAt ?? 0) - (a.lastReceivedAt ?? 0) || b.createdAt - a.createdAt)[0];
	}
	/**
	* Make sure we have an Olm session with each device, claiming one-time keys for those without.
	* Returns the devices we could not get a session with (no one-time key, invalid signature).
	*/
	async ensureSessions(devices, opts = {}) {
		const missing = [];
		for (const d of devices) if (opts.force || (await this.sessions(this.store, d.curve25519)).length === 0) missing.push(d);
		if (missing.length === 0) return [];
		const request = {};
		for (const d of missing) (request[d.userId] ??= {})[d.deviceId] = "signed_curve25519";
		const res = await this.api.endpoint("POST /v3/keys/claim", {}, { body: {
			one_time_keys: request,
			timeout: 1e4
		} });
		const failed = [];
		await this.store.transaction(async (tx) => {
			const { record, account } = await loadAccount(tx, this.pickler);
			for (const d of missing) {
				const keys = res.one_time_keys?.[d.userId]?.[d.deviceId];
				const entry = keys && Object.entries(keys).find(([id]) => id.startsWith("signed_curve25519:"));
				const otk = entry && typeof entry[1] === "object" && entry[1] !== null ? entry[1] : void 0;
				if (!otk || typeof otk.key !== "string" || !verifyObject(this.pickler.protocol, otk, d.userId, d.deviceId, d.ed25519)) {
					if (entry) this.logger.warn("claimed one-time key has no valid signature", {
						userId: d.userId,
						deviceId: d.deviceId
					});
					failed.push(d);
					continue;
				}
				try {
					const session = account.createOutboundSession(d.curve25519, otk.key);
					const sessionId = session.sessionId();
					tx.put("olm_sessions", olmSessionKey(d.curve25519, sessionId), {
						pickle: this.pickler.pickle(session),
						sessionId,
						senderKey: d.curve25519,
						createdAt: Date.now()
					});
				} catch (e) {
					this.logger.warn("could not start an Olm session", {
						userId: d.userId,
						deviceId: d.deviceId,
						...describeError(e)
					});
					failed.push(d);
				}
			}
			saveAccount(tx, this.pickler, record, account);
		});
		return failed;
	}
	/**
	* Encrypt a to-device payload for `device` (which must have a session: ensureSessions). The
	* payload binds sender and recipient, as the spec requires, so it cannot be redirected.
	*/
	async encrypt(tx, device, type, content) {
		const record = OlmService.preferred(await this.sessions(tx, device.curve25519));
		if (!record) return void 0;
		const session = this.pickler.session(record);
		const payload = {
			type,
			content,
			sender: this.userId,
			sender_device: this.deviceId,
			keys: { ed25519: this.identityKeys.ed25519 },
			recipient: device.userId,
			recipient_keys: { ed25519: device.ed25519 }
		};
		const message = session.encrypt(encodeUtf8(JSON.stringify(payload)));
		tx.put("olm_sessions", olmSessionKey(device.curve25519, record.sessionId), {
			...record,
			pickle: this.pickler.pickle(session)
		});
		return {
			algorithm: OLM_ALGORITHM,
			sender_key: this.identityKeys.curve25519,
			ciphertext: { [device.curve25519]: message }
		};
	}
	/**
	* Decrypt an m.room.encrypted to-device event. A pre-key message that no existing session
	* matches starts a new inbound session (using up our one-time key); one that an existing
	* session matches but that does not decrypt is refused (a replay must not start a second
	* session from a fallback key).
	*/
	async decrypt(tx, event) {
		const content = event.content ?? {};
		if (content.algorithm !== "m.olm.v1.curve25519-aes-sha2" || typeof content.sender_key !== "string" || typeof event.sender !== "string") throw new OlmDecryptionError("BAD_FORMAT", "Not an Olm message");
		const senderKey = content.sender_key;
		const message = content.ciphertext?.[this.identityKeys.curve25519];
		if (!message) throw new OlmDecryptionError("NOT_FOR_US", "The message has no ciphertext for this device");
		if (message.type !== 0 && message.type !== 1 || typeof message.body !== "string") throw new OlmDecryptionError("BAD_FORMAT", "Malformed Olm message");
		let plaintext;
		let matched = false;
		for (const record of await this.sessions(tx, senderKey)) {
			const session = this.pickler.session(record);
			if (message.type === 0 && !session.sessionMatches(message)) continue;
			matched = matched || message.type === 0;
			try {
				plaintext = session.decrypt(message);
			} catch (e) {
				if (!(e instanceof ProtocolError)) throw e;
				continue;
			}
			tx.put("olm_sessions", olmSessionKey(senderKey, record.sessionId), {
				...record,
				pickle: this.pickler.pickle(session),
				lastReceivedAt: Date.now()
			});
			break;
		}
		if (!plaintext) {
			if (message.type === 1) throw new OlmDecryptionError("DECRYPT_FAILED", "No Olm session decrypts the message");
			if (matched) throw new OlmDecryptionError("REPLAYED", "Pre-key message for an existing session does not decrypt (replayed)");
			const { record, account } = await loadAccount(tx, this.pickler);
			try {
				const created = account.createInboundSession(senderKey, message);
				plaintext = created.plaintext;
				const sessionId = created.session.sessionId();
				tx.put("olm_sessions", olmSessionKey(senderKey, sessionId), {
					pickle: this.pickler.pickle(created.session),
					sessionId,
					senderKey,
					createdAt: Date.now(),
					lastReceivedAt: Date.now()
				});
				saveAccount(tx, this.pickler, record, account);
			} catch (e) {
				if (!(e instanceof ProtocolError)) throw e;
				throw new OlmDecryptionError("NO_SESSION", `Pre-key message does not start a session (${e.code})`);
			}
		}
		let payload;
		try {
			payload = JSON.parse(decodeUtf8(plaintext));
		} catch {
			throw new OlmDecryptionError("BAD_FORMAT", "Olm plaintext is not JSON");
		}
		if (typeof payload !== "object" || payload === null || typeof payload.type !== "string" || typeof payload.content !== "object" || payload.content === null) throw new OlmDecryptionError("BAD_FORMAT", "Olm payload has no type or content");
		if (payload.sender !== event.sender) throw new OlmDecryptionError("PAYLOAD_MISMATCH", "Olm payload sender differs from the event's");
		if (payload.recipient !== this.userId) throw new OlmDecryptionError("PAYLOAD_MISMATCH", "Olm payload is for another user");
		if (payload.recipient_keys?.ed25519 !== this.identityKeys.ed25519) throw new OlmDecryptionError("PAYLOAD_MISMATCH", "Olm payload is for another device");
		const claimed = payload.keys?.ed25519;
		if (typeof claimed !== "string") throw new OlmDecryptionError("BAD_FORMAT", "Olm payload has no sender keys");
		const device = await this.devices.deviceByCurveKey(event.sender, senderKey, tx);
		if (device && device.ed25519 !== claimed) throw new OlmDecryptionError("DEVICE_KEY_MISMATCH", "Olm payload claims another Ed25519 key than the sending device's");
		return {
			type: payload.type,
			content: payload.content,
			sender: event.sender,
			senderKey,
			claimedEd25519Key: claimed,
			senderDevice: device
		};
	}
	/** PUT /sendToDevice, in chunks (large rooms can mean thousands of devices). */
	async sendToDevice(type, messages, txnId) {
		for (let i = 0; i < messages.length; i += 250) {
			const body = {};
			for (const { device, content } of messages.slice(i, i + 250)) (body[device.userId] ??= {})[device.deviceId] = content;
			await this.api.endpoint("PUT /v3/sendToDevice/:eventType/:txnId", {
				eventType: type,
				txnId: txnId()
			}, { body: { messages: body } });
		}
	}
};
export { OlmDecryptionError, OlmService };

//# sourceMappingURL=olm.js.map