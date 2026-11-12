import { describeError } from "../util/logger.js";
import { decodeUtf8, encodeUtf8 } from "../shared/utf8.js";
import { isObject } from "../shared/json.js";
import { KeyedMutex } from "../util/mutex.js";
import { inboundKey } from "./crypto-store.js";
import { MEGOLM_ALGORITHM } from "./keys.js";
import { ProtocolError } from "../protocol/protocol.js";
// src/e2ee/megolm.ts
/**
* Defaults of m.room.encryption (https://spec.matrix.org/v1.16/client-server-api/#mroomencryption):
* a week and 100 messages.
*/
const DEFAULT_ROTATION_MS = 6048e5;
const DEFAULT_ROTATION_MSGS = 100;
var MegolmDecryptionError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.name = "MegolmDecryptionError";
		this.code = code;
	}
};
/** Megolm in rooms (m.megolm.v1.aes-sha2): our outbound sessions and their sharing, and decryption. */
var MegolmService = class {
	store;
	pickler;
	olm;
	devices;
	logger;
	txnId;
	roomLocks = new KeyedMutex();
	/** Set by the engine when only verified devices may get keys. */
	deviceFilter;
	constructor(opts) {
		this.store = opts.store;
		this.pickler = opts.pickler;
		this.olm = opts.olm;
		this.devices = opts.devices;
		this.logger = opts.logger;
		this.txnId = opts.txnId;
	}
	/** Encrypt an event for a room: rotate the session if due, share it with new devices, encrypt. */
	encrypt(room, type, content) {
		return this.roomLocks.run(room.roomId, async () => {
			if (room.algorithm !== "m.megolm.v1.aes-sha2") throw new Error(`Unsupported room encryption algorithm ${room.algorithm}`);
			const all = await this.targetDevices(room);
			const targets = [];
			const refused = [];
			for (const d of all) (!this.deviceFilter || await this.deviceFilter(d, room.roomId) ? targets : refused).push(d);
			const outbound = await this.prepareSession(room, targets);
			await this.share(room, outbound, targets);
			if (refused.length) await this.withhold(room, refused, "m.unverified", "The sender only shares keys with verified devices.");
			return this.encryptWith(room, type, content);
		});
	}
	/** Devices to share with: every device with Megolm of every target user, except this one. */
	async targetDevices(room) {
		const users = [.../* @__PURE__ */ new Set([...room.members, this.olm.userId])];
		await this.store.transaction((tx) => this.devices.track(tx, users));
		await this.devices.refresh(users);
		const out = [];
		for (const userId of users) {
			if (userId !== this.olm.userId && !room.members.includes(userId)) continue;
			for (const d of await this.devices.devices(userId)) {
				if (d.userId === this.olm.userId && d.deviceId === this.olm.deviceId) continue;
				if (!d.algorithms.includes("m.megolm.v1.aes-sha2")) continue;
				out.push(d);
			}
		}
		return out;
	}
	/**
	* The outbound session to use, rotated when: its message or time budget is used up; the room's
	* encryption settings or history visibility changed; or a device that has the key is no longer
	* a target (a member left, a device was removed), as it must not read what follows.
	*/
	async prepareSession(room, targets) {
		return this.store.transaction(async (tx) => {
			const existing = await tx.get("outbound_group_sessions", room.roomId);
			const settings = {
				algorithm: room.algorithm,
				rotationPeriodMs: room.rotationPeriodMs ?? DEFAULT_ROTATION_MS,
				rotationPeriodMsgs: room.rotationPeriodMsgs ?? DEFAULT_ROTATION_MSGS,
				historyVisibility: room.historyVisibility
			};
			const current = new Set(targets.map((d) => `${d.userId}|${d.deviceId}|${d.curve25519}`));
			const reason = !existing ? "new" : existing.messageCount >= settings.rotationPeriodMsgs ? "message budget" : Date.now() - existing.createdAt >= settings.rotationPeriodMs ? "age" : JSON.stringify(existing.settings) !== JSON.stringify(settings) ? "settings" : Object.entries(existing.sharedWith).some(([k, s]) => s.withheld === void 0 && !current.has(`${k}|${s.curve25519}`)) ? "device removed" : void 0;
			if (!reason) return existing;
			const session = this.pickler.protocol.newOutboundGroupSession();
			const sessionId = session.sessionId();
			if (existing) this.logger.info("rotating the room's Megolm session", {
				roomId: room.roomId,
				reason
			});
			const record = {
				pickle: this.pickler.pickle(session),
				sessionId,
				roomId: room.roomId,
				createdAt: Date.now(),
				messageCount: 0,
				sharedWith: {},
				settings
			};
			tx.put("outbound_group_sessions", room.roomId, record);
			const inbound = this.pickler.protocol.inboundGroupSessionFromSessionKey(session.sessionKey());
			tx.put("inbound_group_sessions", inboundKey(room.roomId, sessionId), {
				pickle: this.pickler.pickle(inbound),
				roomId: room.roomId,
				sessionId,
				senderKey: this.olm.identityKeys.curve25519,
				senderUserId: this.olm.userId,
				claimedEd25519Key: this.olm.identityKeys.ed25519,
				firstKnownIndex: inbound.firstKnownIndex(),
				source: "own"
			});
			return record;
		});
	}
	/** Send the session key (at its current index) to every target device that does not have it. */
	async share(room, record, targets) {
		const pending = targets.filter((d) => {
			const s = record.sharedWith[`${d.userId}|${d.deviceId}`];
			return !s || s.curve25519 !== d.curve25519 || s.withheld === "m.unverified";
		});
		if (pending.length === 0) return;
		const noSession = new Set((await this.olm.ensureSessions(pending)).map((d) => `${d.userId}|${d.deviceId}`));
		const messages = [];
		let index = 0;
		await this.store.transaction(async (tx) => {
			const current = await tx.get("outbound_group_sessions", room.roomId);
			const session = this.pickler.outbound(current);
			index = session.messageIndex();
			const roomKey = {
				algorithm: MEGOLM_ALGORITHM,
				room_id: room.roomId,
				session_id: session.sessionId(),
				session_key: session.sessionKey()
			};
			for (const d of pending) {
				if (noSession.has(`${d.userId}|${d.deviceId}`)) continue;
				const content = await this.olm.encrypt(tx, d, "m.room_key", roomKey);
				if (content) messages.push({
					device: d,
					content
				});
			}
		});
		await this.olm.sendToDevice("m.room.encrypted", messages, this.txnId);
		const withheld = pending.filter((d) => noSession.has(`${d.userId}|${d.deviceId}`));
		if (withheld.length > 0) await this.olm.sendToDevice("m.room_key.withheld", withheld.map((device) => ({
			device,
			content: {
				algorithm: MEGOLM_ALGORITHM,
				room_id: room.roomId,
				session_id: record.sessionId,
				sender_key: this.olm.identityKeys.curve25519,
				code: "m.no_olm",
				reason: "Unable to establish a secure channel."
			}
		})), this.txnId).catch((e) => this.logger.warn("could not send m.room_key.withheld", describeError(e)));
		await this.store.transaction(async (tx) => {
			const current = await tx.get("outbound_group_sessions", room.roomId);
			const sharedWith = { ...current.sharedWith };
			for (const { device } of messages) sharedWith[`${device.userId}|${device.deviceId}`] = {
				curve25519: device.curve25519,
				index
			};
			for (const device of withheld) sharedWith[`${device.userId}|${device.deviceId}`] = {
				curve25519: device.curve25519,
				withheld: "m.no_olm"
			};
			tx.put("outbound_group_sessions", room.roomId, {
				...current,
				sharedWith
			});
		});
	}
	/** Tell devices, once per session, that they will not get its key (m.room_key.withheld, unencrypted). */
	async withhold(room, devices, code, reason) {
		const record = await this.store.get("outbound_group_sessions", room.roomId);
		const fresh = devices.filter((d) => record.sharedWith[`${d.userId}|${d.deviceId}`]?.withheld !== code);
		if (fresh.length === 0) return;
		await this.olm.sendToDevice("m.room_key.withheld", fresh.map((device) => ({
			device,
			content: {
				algorithm: MEGOLM_ALGORITHM,
				room_id: room.roomId,
				session_id: record.sessionId,
				sender_key: this.olm.identityKeys.curve25519,
				code,
				reason
			}
		})), this.txnId).catch((e) => this.logger.warn("could not send m.room_key.withheld", describeError(e)));
		await this.store.transaction(async (tx) => {
			const current = await tx.get("outbound_group_sessions", room.roomId);
			const sharedWith = { ...current.sharedWith };
			for (const d of fresh) if (!sharedWith[`${d.userId}|${d.deviceId}`]?.index) sharedWith[`${d.userId}|${d.deviceId}`] = {
				curve25519: d.curve25519,
				withheld: code
			};
			tx.put("outbound_group_sessions", room.roomId, {
				...current,
				sharedWith
			});
		});
	}
	encryptWith(room, type, content) {
		return this.store.transaction(async (tx) => {
			const record = await tx.get("outbound_group_sessions", room.roomId);
			const session = this.pickler.outbound(record);
			const { "m.relates_to": relatesTo, ...clearContent } = content;
			const ciphertext = session.encrypt(encodeUtf8(JSON.stringify({
				type,
				content: clearContent,
				room_id: room.roomId
			})));
			tx.put("outbound_group_sessions", room.roomId, {
				...record,
				pickle: this.pickler.pickle(session),
				messageCount: record.messageCount + 1
			});
			return {
				algorithm: MEGOLM_ALGORITHM,
				ciphertext,
				session_id: record.sessionId,
				sender_key: this.olm.identityKeys.curve25519,
				device_id: this.olm.deviceId,
				...relatesTo !== void 0 ? { "m.relates_to": relatesTo } : {}
			};
		});
	}
	/** Force a new session for the next message in the room (for example after a membership change). */
	async discardSession(roomId) {
		await this.roomLocks.run(roomId, () => this.store.transaction(async (tx) => tx.delete("outbound_group_sessions", roomId)));
	}
	/**
	* An m.room_key that arrived over Olm. Returns the session's room and ID if it was stored. The
	* session key's signature is verified by the protocol (the key proves its own origin), and the
	* session ID must be the key's.
	*/
	async handleRoomKey(tx, decrypted) {
		const c = decrypted.content;
		if (c.algorithm !== "m.megolm.v1.aes-sha2" || typeof c.room_id !== "string" || typeof c.session_id !== "string" || typeof c.session_key !== "string") {
			this.logger.warn("ignoring a malformed m.room_key", { sender: decrypted.sender });
			return;
		}
		let session;
		try {
			session = this.pickler.protocol.inboundGroupSessionFromSessionKey(c.session_key);
		} catch (e) {
			this.logger.warn("ignoring an m.room_key that does not verify", {
				sender: decrypted.sender,
				...describeError(e)
			});
			return;
		}
		if (session.sessionId() !== c.session_id) {
			this.logger.warn("ignoring an m.room_key whose session ID is not its key's", { sender: decrypted.sender });
			return;
		}
		const key = inboundKey(c.room_id, c.session_id);
		const existing = await tx.get("inbound_group_sessions", key);
		if (existing) {
			const weaker = existing.source === "forwarded" || existing.source === "backup";
			if (existing.senderKey !== decrypted.senderKey || !weaker && existing.senderUserId !== decrypted.sender) {
				this.logger.warn("ignoring an m.room_key for a session another device sent", {
					sender: decrypted.sender,
					roomId: c.room_id
				});
				return;
			}
			const order = session.compare(this.pickler.inbound(existing));
			if (order !== "better" && !(weaker && order === "equal")) return void 0;
		}
		tx.put("inbound_group_sessions", key, {
			pickle: this.pickler.pickle(session),
			roomId: c.room_id,
			sessionId: c.session_id,
			senderKey: decrypted.senderKey,
			senderUserId: decrypted.sender,
			claimedEd25519Key: decrypted.claimedEd25519Key,
			firstKnownIndex: session.firstKnownIndex(),
			source: "m.room_key"
		});
		return {
			roomId: c.room_id,
			sessionId: c.session_id
		};
	}
	/**
	* Decrypt a room event. Checks, beyond the protocol's MAC and signature: the plaintext names the
	* event's room; the session belongs to the event's sender; and no other event used the same
	* message index of the session before (a replay). Throws MegolmDecryptionError.
	*/
	async decrypt(event) {
		const content = event.wire.content;
		const roomId = event.roomId;
		if (content.algorithm !== "m.megolm.v1.aes-sha2") throw new MegolmDecryptionError("UNKNOWN_ALGORITHM", "Not a Megolm event");
		if (typeof content.ciphertext !== "string" || typeof content.session_id !== "string" || !roomId || !event.sender) throw new MegolmDecryptionError("BAD_ENCRYPTED_MESSAGE", "Malformed Megolm event");
		return this.store.transaction(async (tx) => {
			const record = await tx.get("inbound_group_sessions", inboundKey(roomId, content.session_id));
			if (!record || content.sender_key !== void 0 && content.sender_key !== record.senderKey) throw new MegolmDecryptionError("MISSING_ROOM_KEY", "No room key for this session");
			let result;
			try {
				result = this.pickler.inbound(record).decrypt(content.ciphertext);
			} catch (e) {
				if (e instanceof ProtocolError && e.code === "UNKNOWN_MESSAGE_INDEX") throw new MegolmDecryptionError("UNKNOWN_MESSAGE_INDEX", "The room key does not reach back to this message");
				if (e instanceof ProtocolError) throw new MegolmDecryptionError("BAD_ENCRYPTED_MESSAGE", `The message does not decrypt (${e.code})`);
				throw e;
			}
			if (record.senderUserId !== "" && record.senderUserId !== event.sender) throw new MegolmDecryptionError("SENDER_MISMATCH", "The room key belongs to another user than the event's sender");
			const indexKey = `${roomId}|${content.session_id}|${result.messageIndex}`;
			const seen = await tx.get("megolm_indices", indexKey);
			if (seen && (seen.eventId !== event.eventId || seen.ts !== event.originServerTs)) throw new MegolmDecryptionError("REPLAYED", "This message index was already used by another event");
			if (!seen) tx.put("megolm_indices", indexKey, {
				eventId: event.eventId,
				ts: event.originServerTs
			});
			let payload;
			try {
				payload = JSON.parse(decodeUtf8(result.plaintext));
			} catch {
				throw new MegolmDecryptionError("BAD_ENCRYPTED_MESSAGE", "The plaintext is not JSON");
			}
			if (!isObject(payload) || typeof payload.type !== "string" || !isObject(payload.content)) throw new MegolmDecryptionError("BAD_ENCRYPTED_MESSAGE", "The plaintext has no type or content");
			if (payload.room_id !== roomId) throw new MegolmDecryptionError("ROOM_MISMATCH", "The plaintext is for another room");
			const clearContent = { ...payload.content };
			if (clearContent["m.relates_to"] === void 0 && content["m.relates_to"] !== void 0) clearContent["m.relates_to"] = content["m.relates_to"];
			const device = await this.devices.deviceByCurveKey(record.senderUserId || event.sender, record.senderKey, tx);
			let authenticity;
			if (record.source === "own") authenticity = "authenticated";
			else if (!device) authenticity = "unknown_device";
			else if (record.source !== "m.room_key") authenticity = "unauthenticated";
			else authenticity = device.ed25519 === record.claimedEd25519Key ? "authenticated" : "unauthenticated";
			return {
				clear: {
					type: payload.type,
					content: clearContent
				},
				info: {
					senderCurve25519Key: record.senderKey,
					claimedEd25519Key: record.claimedEd25519Key,
					senderDeviceId: record.source === "own" ? this.olm.deviceId : device?.deviceId,
					authenticity
				}
			};
		});
	}
};
export { MegolmDecryptionError, MegolmService };

//# sourceMappingURL=megolm.js.map