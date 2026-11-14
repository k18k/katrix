import { TypedEmitter } from "../../util/emitter.js";
import { describeError } from "../../util/logger.js";
import { bytesEqual, constantTimeEqual } from "../../shared/bytes.js";
import { decodeBase64, encodeBase64 } from "../../shared/base64.js";
import { isStringRecord } from "../../shared/json.js";
import { QR_SCAN, QR_SHOW, RECIPROCATE, decodeQr, encodeQr } from "./qr.js";
import { HASH, KEY_AGREEMENT, MAC_METHOD, SAS_METHOD, SAS_TYPES, sasBytes, sasCommitment, sasDecimals, sasEmoji, sasInfo, sasMac } from "./sas.js";
// src/e2ee/verification/request.ts
/** The methods this SDK supports; showing and scanning QR codes needs the app's camera and screen. */
const ALL_METHODS = [
	SAS_METHOD,
	QR_SHOW,
	QR_SCAN,
	RECIPROCATE
];
/**
* One key verification (https://spec.matrix.org/v1.19/client-server-api/#key-verification-framework):
* request → ready → start (SAS or QR) → done, or cancelled at any point. The keys verified are
* fixed when the method starts, as the spec requires, and checked again at the end.
*/
var VerificationRequest = class extends TypedEmitter {
	phase = "requested";
	initiatedByMe;
	otherUserId;
	/** The other side's device: known once it answered (or for a request it sent). */
	otherDeviceId;
	theirMethods = [];
	ourMethods;
	/** "m.sas.v1" or "m.reciprocate.v1" once started. */
	method;
	cancelCode;
	cancelReason;
	/** The verification finished on another of our devices, or the other side answered elsewhere. */
	handledElsewhere = false;
	createdAt = Date.now();
	channel;
	ctx;
	sas;
	/** Keys fixed at the start: the other device's Ed25519 key and the other user's master key. */
	pinned;
	qr;
	scanned;
	theirDone = false;
	ourDone = false;
	constructor(ctx, channel, opts) {
		super();
		this.ctx = ctx;
		this.channel = channel;
		this.initiatedByMe = opts.initiatedByMe;
		this.otherUserId = opts.otherUserId;
		this.otherDeviceId = opts.otherDeviceId;
		this.ourMethods = opts.ourMethods ?? ALL_METHODS;
	}
	get transactionId() {
		return this.channel.transactionId;
	}
	/** The SAS to compare, once the keys are exchanged. */
	get sasCode() {
		return this.sas?.code;
	}
	setPhase(phase) {
		this.phase = phase;
		this.emit("change");
	}
	get common() {
		return this.ourMethods.filter((m) => this.theirMethods.includes(m));
	}
	/** Accept a request from the other side (m.key.verification.ready). */
	async accept() {
		if (this.initiatedByMe || this.phase !== "requested") throw new Error("Only a pending incoming request can be accepted");
		const methods = this.ourMethods.filter((m) => this.theirMethods.includes(m) || m === "m.reciprocate.v1" && this.theirMethods.some((t) => t.startsWith("m.qr_code")));
		if (!methods.some((m) => m === "m.sas.v1" || m === "m.qr_code.show.v1" || m === "m.qr_code.scan.v1")) {
			await this.cancel("m.unknown_method", "No verification method in common");
			return;
		}
		await this.channel.send("m.key.verification.ready", {
			from_device: this.ctx.deviceId,
			methods
		});
		this.setPhase("ready");
	}
	/** Decline or abort (m.key.verification.cancel). */
	async cancel(code = "m.user", reason = "The user cancelled the verification") {
		if (this.phase === "done" || this.phase === "cancelled") return;
		this.cancelCode = code;
		this.cancelReason = reason;
		this.setPhase("cancelled");
		await this.channel.send("m.key.verification.cancel", {
			code,
			reason
		}).catch((e) => this.ctx.logger.warn("could not send a cancellation", describeError(e)));
	}
	/** A message of this verification from the other side (`fromDevice` from its content). */
	async handle(type, content, sender) {
		if (this.phase === "done" || this.phase === "cancelled") return;
		try {
			if (sender === this.ctx.userId && content.from_device !== void 0 && content.from_device !== this.ctx.deviceId && sender !== this.otherUserId) {
				if (type === "m.key.verification.ready" || type === "m.key.verification.start") {
					this.handledElsewhere = true;
					this.setPhase("cancelled");
				}
				return;
			}
			if (sender !== this.otherUserId) return;
			if (this.otherDeviceId && content.from_device !== void 0 && content.from_device !== this.otherDeviceId && type !== "m.key.verification.cancel") return;
			switch (type) {
				case "m.key.verification.ready": return await this.onReady(content);
				case "m.key.verification.start": return await this.onStart(content);
				case "m.key.verification.accept": return await this.onAccept(content);
				case "m.key.verification.key": return await this.onKey(content);
				case "m.key.verification.mac": return await this.onMac(content);
				case "m.key.verification.done": return await this.onDone();
				case "m.key.verification.cancel":
					this.cancelCode = typeof content.code === "string" ? content.code : "m.user";
					this.cancelReason = typeof content.reason === "string" ? content.reason : void 0;
					this.setPhase("cancelled");
					return;
			}
		} catch (e) {
			this.ctx.logger.warn("verification failed", describeError(e));
			await this.cancel("m.unexpected_message", "The verification failed");
		}
	}
	async onReady(content) {
		if (!this.initiatedByMe || this.phase !== "requested") return this.unexpected();
		if (typeof content.from_device !== "string") return this.unexpected();
		this.otherDeviceId = content.from_device;
		this.theirMethods = Array.isArray(content.methods) ? content.methods.filter((m) => typeof m === "string") : [];
		this.channel.narrowTo?.(content.from_device);
		this.setPhase("ready");
	}
	async unexpected() {
		await this.cancel("m.unexpected_message", "Unexpected verification message");
	}
	/** Start SAS verification (after ready). */
	async startSas() {
		if (this.phase !== "ready" || !this.common.includes("m.sas.v1")) throw new Error("SAS cannot be started now");
		await this.pinKeys();
		const startContent = await this.channel.send("m.key.verification.start", {
			from_device: this.ctx.deviceId,
			method: SAS_METHOD,
			key_agreement_protocols: [KEY_AGREEMENT],
			hashes: [HASH],
			message_authentication_codes: [MAC_METHOD],
			short_authentication_string: [...SAS_TYPES]
		});
		this.method = SAS_METHOD;
		this.sas = {
			weStarted: true,
			startContent,
			keyPair: this.ctx.primitives.x25519GenerateKeyPair(),
			sasTypes: [...SAS_TYPES],
			confirmed: false
		};
		this.setPhase("started");
	}
	/** Whether our start wins over theirs when both sent one: the lexicographically smaller user (then device) wins. */
	weWinStartRace() {
		if (this.ctx.userId !== this.otherUserId) return this.ctx.userId < this.otherUserId;
		return this.ctx.deviceId < (this.otherDeviceId ?? "");
	}
	async onStart(content) {
		if (typeof content.from_device === "string") this.otherDeviceId ??= content.from_device;
		if (content.method === "m.reciprocate.v1") return this.onReciprocate(content);
		if (content.method !== "m.sas.v1") return void await this.cancel("m.unknown_method", "Unsupported verification method");
		if (this.phase === "started") {
			if (this.sas?.weStarted && this.method === "m.sas.v1" && this.weWinStartRace()) return;
			if (!this.sas?.weStarted || this.method !== "m.sas.v1") return this.unexpected();
		} else if (this.phase !== "ready" && !(this.phase === "requested" && !this.initiatedByMe)) return this.unexpected();
		const has = (field, value) => Array.isArray(content[field]) && content[field].includes(value);
		if (!has("key_agreement_protocols", "curve25519-hkdf-sha256") || !has("hashes", "sha256") || !has("message_authentication_codes", "hkdf-hmac-sha256.v2")) return void await this.cancel("m.unknown_method", "No key agreement, hash or MAC in common");
		const sasTypes = SAS_TYPES.filter((t) => has("short_authentication_string", t));
		if (sasTypes.length === 0) return void await this.cancel("m.unknown_method", "No SAS method in common");
		await this.pinKeys();
		const keyPair = this.ctx.primitives.x25519GenerateKeyPair();
		const commitment = sasCommitment(this.ctx.primitives, encodeBase64(keyPair.publicKey), content);
		this.sas = {
			weStarted: false,
			startContent: content,
			keyPair,
			sasTypes,
			confirmed: false
		};
		this.method = SAS_METHOD;
		this.setPhase("started");
		await this.channel.send("m.key.verification.accept", {
			method: SAS_METHOD,
			key_agreement_protocol: KEY_AGREEMENT,
			hash: HASH,
			message_authentication_code: MAC_METHOD,
			short_authentication_string: sasTypes,
			commitment
		});
	}
	async onAccept(content) {
		const sas = this.sas;
		if (!sas?.weStarted || sas.commitment !== void 0) return this.unexpected();
		if (content.key_agreement_protocol !== "curve25519-hkdf-sha256" || content.hash !== "sha256" || content.message_authentication_code !== "hkdf-hmac-sha256.v2") return void await this.cancel("m.unknown_method", "Unsupported key agreement, hash or MAC");
		if (typeof content.commitment !== "string") return this.unexpected();
		sas.commitment = content.commitment;
		sas.sasTypes = SAS_TYPES.filter((t) => Array.isArray(content.short_authentication_string) && content.short_authentication_string.includes(t));
		await this.channel.send("m.key.verification.key", { key: encodeBase64(sas.keyPair.publicKey) });
	}
	async onKey(content) {
		const sas = this.sas;
		if (!sas || sas.theirKey !== void 0 || typeof content.key !== "string") return this.unexpected();
		if (sas.weStarted) {
			if (sas.commitment === void 0) return this.unexpected();
			const expected = sasCommitment(this.ctx.primitives, content.key, sas.startContent);
			if (!constantTimeEqual(decodeBase64(expected), decodeBase64(sas.commitment))) return void await this.cancel("m.mismatched_commitment", "The key does not match the commitment");
		}
		sas.theirKey = content.key;
		sas.shared = this.ctx.primitives.x25519SharedSecret(sas.keyPair.secretKey, decodeBase64(content.key));
		const ourKey = encodeBase64(sas.keyPair.publicKey);
		if (!sas.weStarted) await this.channel.send("m.key.verification.key", { key: ourKey });
		const us = {
			user: this.ctx.userId,
			device: this.ctx.deviceId,
			key: ourKey
		};
		const them = {
			user: this.otherUserId,
			device: this.otherDeviceId ?? "",
			key: content.key
		};
		const [start, acc] = sas.weStarted ? [us, them] : [them, us];
		const bytes = sasBytes(this.ctx.primitives, sas.shared, sasInfo({
			startUser: start.user,
			startDevice: start.device,
			startKey: start.key,
			acceptUser: acc.user,
			acceptDevice: acc.device,
			acceptKey: acc.key,
			transactionId: this.transactionId
		}));
		sas.code = {
			emoji: sasEmoji(bytes),
			decimal: sasDecimals(bytes)
		};
		this.emit("sas", sas.code);
		this.emit("change");
	}
	/** The user says the SAS matches: send our MACs (and finish, if theirs are here and check out). */
	async confirmSas() {
		const sas = this.sas;
		if (!sas?.shared || sas.confirmed) throw new Error("There is no SAS to confirm");
		sas.confirmed = true;
		const keys = { [`ed25519:${this.ctx.deviceId}`]: this.ctx.deviceEd25519() };
		const master = await this.ctx.crossSigning.masterKey(this.ctx.userId);
		if (master && (await this.ctx.crossSigning.userTrust(this.ctx.userId)).verified) keys[`ed25519:${master}`] = master;
		const params = (keyId) => ({
			senderUser: this.ctx.userId,
			senderDevice: this.ctx.deviceId,
			otherUser: this.otherUserId,
			otherDevice: this.otherDeviceId ?? "",
			transactionId: this.transactionId,
			keyId
		});
		const mac = {};
		for (const [keyId, key] of Object.entries(keys)) mac[keyId] = sasMac(this.ctx.primitives, sas.shared, params(keyId), key);
		const keyIds = Object.keys(keys).sort().join(",");
		await this.channel.send("m.key.verification.mac", {
			mac,
			keys: sasMac(this.ctx.primitives, sas.shared, params("KEY_IDS"), keyIds)
		});
		if (sas.theirMac) await this.checkTheirMac();
	}
	/** The user says the SAS does not match. */
	mismatchSas() {
		return this.cancel("m.mismatched_sas", "The short authentication strings did not match");
	}
	async onMac(content) {
		const sas = this.sas;
		if (!sas?.shared || sas.theirMac || !isStringRecord(content.mac) || typeof content.keys !== "string") return this.unexpected();
		sas.theirMac = {
			mac: content.mac,
			keys: content.keys
		};
		if (sas.confirmed) await this.checkTheirMac();
	}
	async checkTheirMac() {
		const sas = this.sas;
		const theirs = sas.theirMac;
		const params = (keyId) => ({
			senderUser: this.otherUserId,
			senderDevice: this.otherDeviceId ?? "",
			otherUser: this.ctx.userId,
			otherDevice: this.ctx.deviceId,
			transactionId: this.transactionId,
			keyId
		});
		const keyIds = Object.keys(theirs.mac).sort().join(",");
		if (!macEqual(sasMac(this.ctx.primitives, sas.shared, params("KEY_IDS"), keyIds), theirs.keys)) return void await this.cancel("m.key_mismatch", "The list of keys does not match");
		let deviceVerified = false;
		let masterVerified = false;
		for (const [keyId, mac] of Object.entries(theirs.mac)) {
			const id = keyId.startsWith("ed25519:") ? keyId.slice(8) : void 0;
			if (id === void 0) continue;
			let key;
			if (id === this.otherDeviceId) key = this.pinned?.deviceKey;
			else if (id === this.pinned?.masterKey) key = this.pinned.masterKey;
			if (key === void 0) continue;
			if (!macEqual(sasMac(this.ctx.primitives, sas.shared, params(keyId), key), mac)) return void await this.cancel("m.key_mismatch", "A key does not match");
			if (key === this.pinned?.deviceKey && id === this.otherDeviceId) deviceVerified = true;
			else masterVerified = true;
		}
		if (!deviceVerified && !masterVerified) return void await this.cancel("m.key_mismatch", "No known key was verified");
		await this.trust({
			device: deviceVerified,
			master: masterVerified
		});
		await this.sendDone();
	}
	/**
	* The QR code to show the other side (its bytes, to draw as a byte-mode QR code), when it can
	* scan and we can show one; undefined otherwise.
	*/
	async qrCode() {
		if (this.phase !== "ready" || !this.ourMethods.includes("m.qr_code.show.v1") || !this.theirMethods.includes("m.qr_code.scan.v1")) return void 0;
		if (this.qr) return this.qr.code;
		await this.pinKeys();
		const ownMaster = await this.ctx.crossSigning.masterKey(this.ctx.userId);
		const ownTrusted = (await this.ctx.crossSigning.userTrust(this.ctx.userId)).verified;
		let mode;
		let firstKey;
		let secondKey;
		if (this.otherUserId !== this.ctx.userId) [mode, firstKey, secondKey] = [
			0,
			ownTrusted ? ownMaster : void 0,
			this.pinned?.masterKey
		];
		else if (ownTrusted) [mode, firstKey, secondKey] = [
			1,
			ownMaster,
			this.pinned?.deviceKey
		];
		else [mode, firstKey, secondKey] = [
			2,
			this.ctx.deviceEd25519(),
			ownMaster
		];
		if (!firstKey || !secondKey) return void 0;
		const secret = this.ctx.primitives.randomBytes(16);
		const data = {
			mode,
			transactionId: this.transactionId,
			firstKey: decodeBase64(firstKey),
			secondKey: decodeBase64(secondKey),
			secret
		};
		this.qr = {
			...data,
			code: encodeQr(data)
		};
		return this.qr.code;
	}
	/**
	* We scanned the other side's QR code: check its keys against what we know, verify the other
	* side, and tell it (m.reciprocate.v1). Throws (and cancels) if the code does not match.
	*/
	async scanQrCode(bytes) {
		if (this.phase !== "ready" || !this.ourMethods.includes("m.qr_code.scan.v1")) throw new Error("A QR code cannot be scanned now");
		await this.pinKeys();
		const fail = async (why) => {
			await this.cancel("m.key_mismatch", why);
			throw new Error(why);
		};
		let qr;
		try {
			qr = decodeQr(bytes);
		} catch (e) {
			return fail(e instanceof Error ? e.message : "Not a verification QR code");
		}
		if (qr.transactionId !== this.transactionId) return fail("The QR code is for another verification");
		const b64 = encodeBase64;
		const ownMaster = await this.ctx.crossSigning.masterKey(this.ctx.userId);
		const ownTrusted = (await this.ctx.crossSigning.userTrust(this.ctx.userId)).verified;
		let trust;
		if (qr.mode === 0) {
			if (this.otherUserId === this.ctx.userId || b64(qr.firstKey) !== this.pinned?.masterKey || b64(qr.secondKey) !== ownMaster) return fail("The QR code's keys do not match");
			trust = () => this.trust({
				device: false,
				master: true
			});
		} else if (qr.mode === 1) {
			if (this.otherUserId !== this.ctx.userId || b64(qr.firstKey) !== ownMaster || b64(qr.secondKey) !== this.ctx.deviceEd25519()) return fail("The QR code's keys do not match");
			trust = () => this.trust({
				device: true,
				master: true
			});
		} else {
			if (this.otherUserId !== this.ctx.userId || !ownTrusted || b64(qr.firstKey) !== this.pinned?.deviceKey || b64(qr.secondKey) !== ownMaster) return fail("The QR code's keys do not match");
			trust = () => this.trust({
				device: true,
				master: false
			});
		}
		this.method = RECIPROCATE;
		this.scanned = {
			mode: qr.mode,
			trust
		};
		await this.channel.send("m.key.verification.start", {
			from_device: this.ctx.deviceId,
			method: RECIPROCATE,
			secret: b64(qr.secret)
		});
		this.setPhase("started");
		await trust();
		if (this.theirDone) await this.sendDone();
	}
	async onReciprocate(content) {
		if (!this.qr || this.phase !== "ready" || typeof content.secret !== "string") return this.unexpected();
		if (!bytesEqual(decodeBase64(content.secret), this.qr.secret)) return void await this.cancel("m.key_mismatch", "The QR code secret does not match");
		this.method = RECIPROCATE;
		this.setPhase("started");
		this.emit("qrScanned");
	}
	/** The user confirms the other device scanned our QR code (it showed success): verify it, finish. */
	async confirmQrScanned() {
		const qr = this.qr;
		if (!qr || this.method !== "m.reciprocate.v1" || this.phase !== "started") throw new Error("No QR code was scanned");
		if (qr.mode === 0) await this.trust({
			device: false,
			master: true
		});
		else if (qr.mode === 1) await this.trust({
			device: true,
			master: false
		});
		else await this.trust({
			device: true,
			master: true
		});
		await this.sendDone();
	}
	async onDone() {
		this.theirDone = true;
		if (this.scanned && !this.ourDone) await this.sendDone();
		else if (this.ourDone) this.setPhase("done");
	}
	async sendDone() {
		if (this.ourDone) return;
		this.ourDone = true;
		await this.channel.send("m.key.verification.done", {});
		this.setPhase("done");
		this.ctx.onVerified?.(this);
	}
	/** Fix the keys being verified (spec: they must not change during the verification). */
	async pinKeys() {
		if (this.pinned) return;
		await this.ctx.devices.refresh([this.otherUserId]);
		const rec = await this.ctx.devices.getUser(this.otherUserId);
		const masterKey = await this.ctx.crossSigning.masterKey(this.otherUserId);
		if (masterKey && rec?.devices[masterKey]) {
			await this.cancel("m.key_mismatch", "A device ID collides with a cross-signing key");
			throw new Error("A device ID collides with a cross-signing key");
		}
		this.pinned = {
			deviceKey: this.otherDeviceId ? rec?.devices[this.otherDeviceId]?.ed25519 : void 0,
			masterKey
		};
	}
	/** Record what was verified: the other device, the other user's (or our own) master key. */
	async trust(what) {
		const cs = this.ctx.crossSigning;
		const ownUser = this.otherUserId === this.ctx.userId;
		if (what.device && this.otherDeviceId) {
			await cs.setDeviceVerified(this.otherUserId, this.otherDeviceId);
			if (ownUser && (await cs.privateKeys()).selfSigning) await cs.signOwnDevice(this.otherDeviceId).catch((e) => this.ctx.logger.warn("could not sign the device", describeError(e)));
		}
		if (what.master && this.pinned?.masterKey) {
			if (ownUser) await cs.markOwnIdentityVerified();
			else if ((await cs.privateKeys()).userSigning && (await cs.userTrust(this.ctx.userId)).verified) await cs.verifyUser(this.otherUserId, this.pinned.masterKey);
			else if (this.otherDeviceId) await cs.setDeviceVerified(this.otherUserId, this.otherDeviceId);
		}
	}
};
function macEqual(a, b) {
	try {
		return constantTimeEqual(decodeBase64(a), decodeBase64(b));
	} catch {
		return false;
	}
}
export { ALL_METHODS, VerificationRequest };

//# sourceMappingURL=request.js.map