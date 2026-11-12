import { describeError } from "../../util/logger.js";
import { isObject } from "../../shared/json.js";
import { TypedEmitter } from "../../util/emitter.js";
import { ALL_METHODS, VerificationRequest } from "./request.js";
// src/e2ee/verification/manager.ts
/** Requests older than this are not shown (spec: 10 minutes after their timestamp). */
const REQUEST_LIFETIME_MS = 6e5;
const VERIFICATION_TYPES = /* @__PURE__ */ new Set([
	"m.key.verification.request",
	"m.key.verification.ready",
	"m.key.verification.start",
	"m.key.verification.accept",
	"m.key.verification.key",
	"m.key.verification.mac",
	"m.key.verification.done",
	"m.key.verification.cancel"
]);
/**
* Key verification between devices (https://spec.matrix.org/v1.19/client-server-api/#device-verification):
* to-device for the user's own devices, in a room for other users, as the spec recommends.
* Messages are routed to their VerificationRequest by transaction ID or by the request event.
*/
var VerificationManager = class extends TypedEmitter {
	ctx;
	api;
	txnId;
	sendRoomEvent;
	byTxn = /* @__PURE__ */ new Map();
	byEvent = /* @__PURE__ */ new Map();
	constructor(opts) {
		super();
		this.ctx = opts.ctx;
		this.api = opts.api;
		this.txnId = opts.txnId;
		this.sendRoomEvent = opts.sendRoomEvent;
	}
	/** The verifications in progress or recently finished. */
	requests() {
		return [.../* @__PURE__ */ new Set([...this.byTxn.values(), ...this.byEvent.values()])];
	}
	toDeviceChannel(transactionId, userId, deviceIds) {
		let targets = deviceIds;
		return {
			kind: "to-device",
			transactionId,
			send: async (type, content) => {
				const full = {
					...content,
					transaction_id: transactionId
				};
				await this.api.endpoint("PUT /v3/sendToDevice/:eventType/:txnId", {
					eventType: type,
					txnId: this.txnId()
				}, { body: { messages: { [userId]: Object.fromEntries(targets.map((d) => [d, full])) } } });
				return full;
			},
			narrowTo: (deviceId) => {
				const others = targets.filter((d) => d !== deviceId && d !== "*");
				targets = [deviceId];
				if (others.length) this.api.endpoint("PUT /v3/sendToDevice/:eventType/:txnId", {
					eventType: "m.key.verification.cancel",
					txnId: this.txnId()
				}, { body: { messages: { [userId]: Object.fromEntries(others.map((d) => [d, {
					transaction_id: transactionId,
					code: "m.accepted",
					reason: "Verified on another device"
				}])) } } }).catch((e) => this.ctx.logger.warn("could not cancel the request at other devices", describeError(e)));
			}
		};
	}
	roomChannel(roomId, eventId) {
		return {
			kind: "room",
			transactionId: eventId,
			send: async (type, content) => {
				const full = {
					...content,
					"m.relates_to": {
						rel_type: "m.reference",
						event_id: eventId
					}
				};
				await this.sendRoomEvent(roomId, type, full);
				return full;
			}
		};
	}
	/**
	* Verify another device of this user (to-device): all of them, or one. The first that accepts
	* gets the verification; the others are told it was taken.
	*/
	async requestOwnDeviceVerification(deviceId) {
		await this.ctx.devices.refresh([this.ctx.userId]);
		const devices = deviceId ? [deviceId] : (await this.ctx.devices.devices(this.ctx.userId)).map((d) => d.deviceId).filter((d) => d !== this.ctx.deviceId);
		if (devices.length === 0) throw new Error("There is no other device to verify with");
		const transactionId = this.txnId();
		const request = new VerificationRequest(this.ctx, this.toDeviceChannel(transactionId, this.ctx.userId, devices), {
			initiatedByMe: true,
			otherUserId: this.ctx.userId,
			otherDeviceId: deviceId
		});
		this.byTxn.set(transactionId, request);
		await request.channel.send("m.key.verification.request", {
			from_device: this.ctx.deviceId,
			methods: ALL_METHODS,
			timestamp: Date.now()
		});
		return request;
	}
	/** Verify another user, in a room with them (preferably the direct chat). */
	async requestUserVerification(roomId, userId) {
		const eventId = await this.sendRoomEvent(roomId, "m.room.message", {
			msgtype: "m.key.verification.request",
			body: `${this.ctx.userId} is asking to verify your key, but your client does not support in-chat key verification.`,
			from_device: this.ctx.deviceId,
			methods: ALL_METHODS,
			to: userId
		});
		const request = new VerificationRequest(this.ctx, this.roomChannel(roomId, eventId), {
			initiatedByMe: true,
			otherUserId: userId
		});
		this.byEvent.set(eventId, request);
		return request;
	}
	/** A to-device event from /sync (plaintext or decrypted). */
	async handleToDevice(event) {
		if (!VERIFICATION_TYPES.has(event.type)) return;
		const c = event.content;
		const txn = c.transaction_id;
		if (typeof txn !== "string") return;
		let request = this.byTxn.get(txn);
		if (event.type === "m.key.verification.request") {
			if (request || typeof c.from_device !== "string" || !Array.isArray(c.methods)) return;
			if (typeof c.timestamp === "number" && Math.abs(Date.now() - c.timestamp) > REQUEST_LIFETIME_MS) return;
			request = new VerificationRequest(this.ctx, this.toDeviceChannel(txn, event.sender, [c.from_device]), {
				initiatedByMe: false,
				otherUserId: event.sender,
				otherDeviceId: c.from_device
			});
			request.theirMethods = c.methods.filter((m) => typeof m === "string");
			this.byTxn.set(txn, request);
			this.emit("request", request);
			return;
		}
		if (!request) {
			if (event.type === "m.key.verification.start" && typeof c.from_device === "string") {
				request = new VerificationRequest(this.ctx, this.toDeviceChannel(txn, event.sender, [c.from_device]), {
					initiatedByMe: false,
					otherUserId: event.sender,
					otherDeviceId: c.from_device
				});
				request.phase = "ready";
				request.theirMethods = typeof c.method === "string" ? [c.method] : [];
				this.byTxn.set(txn, request);
				this.emit("request", request);
			} else {
				if (event.type !== "m.key.verification.cancel" && typeof c.from_device === "string") await this.toDeviceChannel(txn, event.sender, [c.from_device]).send("m.key.verification.cancel", {
					code: "m.unknown_transaction",
					reason: "Unknown verification"
				}).catch(() => {});
				return;
			}
		}
		await request.handle(event.type, c, event.sender);
	}
	/** A room event (decrypted if it was encrypted) that may belong to a verification. */
	async handleRoomEvent(event) {
		const c = event.content;
		if (!event.sender || !event.roomId) return;
		if (event.type === "m.room.message" && c.msgtype === "m.key.verification.request") {
			if (!event.eventId || this.byEvent.has(event.eventId) || c.to !== this.ctx.userId || event.sender === this.ctx.userId) return;
			if (event.originServerTs !== void 0 && Date.now() - event.originServerTs > REQUEST_LIFETIME_MS) return;
			if (typeof c.from_device !== "string" || !Array.isArray(c.methods)) return;
			const request = new VerificationRequest(this.ctx, this.roomChannel(event.roomId, event.eventId), {
				initiatedByMe: false,
				otherUserId: event.sender,
				otherDeviceId: c.from_device
			});
			request.theirMethods = c.methods.filter((m) => typeof m === "string");
			this.byEvent.set(event.eventId, request);
			this.emit("request", request);
			return;
		}
		if (!VERIFICATION_TYPES.has(event.type)) return;
		const rel = isObject(c["m.relates_to"]) ? c["m.relates_to"] : void 0;
		const request = rel?.rel_type === "m.reference" && typeof rel.event_id === "string" ? this.byEvent.get(rel.event_id) : void 0;
		if (!request) return;
		if (event.sender === this.ctx.userId && c.from_device === this.ctx.deviceId) return;
		if (event.sender === this.ctx.userId && c.from_device === void 0 && request.otherUserId !== this.ctx.userId) return;
		await request.handle(event.type, c, event.sender);
	}
};
export { VerificationManager };

//# sourceMappingURL=manager.js.map