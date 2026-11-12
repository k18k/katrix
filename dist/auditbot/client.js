import { DeviceId, DeviceLists, OlmMachine, RoomId, RoomMessageRequest, ToDeviceRequest, UserId } from "@matrix-org/matrix-sdk-crypto-nodejs";
// src/auditbot/client.ts
/** The request types of matrix-sdk-crypto (a const enum in its typings). */
const Req = {
	KeysUpload: 0,
	KeysQuery: 1,
	KeysClaim: 2,
	ToDevice: 3,
	SignatureUpload: 4,
	RoomMessage: 5,
	KeysBackup: 6
};
/**
* matrix-sdk-crypto puts signature uploads under `signed_keys`; the endpoint takes the map of
* signatures itself as the body.
*/
function signatureUploadBody(body) {
	const parsed = JSON.parse(body);
	return Object.keys(parsed).length === 1 && parsed.signed_keys ? JSON.stringify(parsed.signed_keys) : body;
}
var MatrixError = class extends Error {
	status;
	body;
	constructor(status, body) {
		super(`${status} ${body.errcode ?? ""} ${body.error ?? ""}`.trim());
		this.status = status;
		this.body = body;
	}
};
var CryptoClient = class {
	userId;
	deviceId;
	accessToken;
	fetch;
	baseUrl;
	txn = 0;
	machine;
	constructor(opts) {
		this.fetch = opts.fetch;
		this.baseUrl = opts.baseUrl ?? "http://localhost";
		this.userId = opts.userId;
		this.deviceId = opts.deviceId;
		this.accessToken = opts.accessToken;
	}
	/**
	* Open the crypto store. With `storePath`, keys live in an encrypted SQLite store there (they
	* must survive restarts: room keys are sent once). Without, in memory (tests).
	*/
	async open(storePath, passphrase) {
		this.machine = await OlmMachine.initialize(new UserId(this.userId), new DeviceId(this.deviceId), storePath ?? null, passphrase ?? null, storePath ? 0 : null);
	}
	async request(method, path, body, signal) {
		const res = await this.fetch(new Request(`${this.baseUrl}${path}`, {
			method,
			signal,
			headers: {
				authorization: `Bearer ${this.accessToken}`,
				"content-type": "application/json"
			},
			body: body === void 0 ? void 0 : typeof body === "string" ? body : JSON.stringify(body)
		}));
		const text = await res.text();
		const json = text ? JSON.parse(text) : {};
		if (!res.ok) throw new MatrixError(res.status, json);
		return json;
	}
	/** Feed a /sync response to the crypto machine, then send what it needs sent. */
	async receiveSync(sync) {
		const changed = (sync.device_lists?.changed ?? []).map((u) => new UserId(u));
		const left = (sync.device_lists?.left ?? []).map((u) => new UserId(u));
		await this.machine.receiveSyncChanges(JSON.stringify(sync.to_device?.events ?? []), new DeviceLists(changed, left), sync.device_one_time_keys_count ?? {}, sync.device_unused_fallback_key_types ?? []);
		await this.flush();
	}
	/** Send every outgoing request of the crypto machine (key uploads, queries, claims, to-device). */
	async flush() {
		for (let round = 0; round < 10; round++) {
			const requests = await this.machine.outgoingRequests();
			if (requests.length === 0) return;
			for (const r of requests) {
				let response;
				switch (r.type) {
					case Req.KeysUpload:
						response = await this.request("POST", "/_matrix/client/v3/keys/upload", r.body);
						break;
					case Req.KeysQuery:
						response = await this.request("POST", "/_matrix/client/v3/keys/query", r.body);
						break;
					case Req.KeysClaim:
						response = await this.request("POST", "/_matrix/client/v3/keys/claim", r.body);
						break;
					case Req.SignatureUpload:
						response = await this.request("POST", "/_matrix/client/v3/keys/signatures/upload", signatureUploadBody(r.body));
						break;
					case Req.ToDevice:
						if (!(r instanceof ToDeviceRequest)) continue;
						response = await this.request("PUT", `/_matrix/client/v3/sendToDevice/${encodeURIComponent(r.eventType)}/${encodeURIComponent(r.txnId)}`, r.body);
						break;
					case Req.RoomMessage:
						if (!(r instanceof RoomMessageRequest)) continue;
						response = await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(r.roomId)}/send/${encodeURIComponent(r.eventType)}/${encodeURIComponent(r.txnId)}`, r.body);
						break;
					default: continue;
				}
				await this.machine.markRequestAsSent(r.id, r.type, JSON.stringify(response));
			}
		}
	}
	/** Make sure the crypto machine knows these users' devices. */
	async track(users) {
		await this.machine.updateTrackedUsers(users.map((u) => new UserId(u)));
		await this.flush();
	}
	decrypt(event, roomId) {
		return this.machine.decryptRoomEvent(JSON.stringify(event), new RoomId(roomId));
	}
	/**
	* Set up cross-signing for this account and sign the device with it, so other users' clients
	* see the device as its owner's (not as an unknown one). Only once: an existing identity is kept.
	*/
	async ensureCrossSigning() {
		const status = await this.machine.crossSigningStatus();
		if (status.hasMaster && status.hasSelfSigning) return;
		const requests = await this.machine.bootstrapCrossSigning(true);
		if (requests.uploadKeysReq) {
			const response = await this.request("POST", "/_matrix/client/v3/keys/upload", requests.uploadKeysReq.body);
			await this.machine.markRequestAsSent(requests.uploadKeysReq.id, requests.uploadKeysReq.type, JSON.stringify(response));
		}
		await this.request("POST", "/_matrix/client/v3/keys/device_signing/upload", requests.uploadSigningKeysReq);
		const signatures = await this.request("POST", "/_matrix/client/v3/keys/signatures/upload", signatureUploadBody(requests.uploadSignaturesReq.body));
		await this.machine.markRequestAsSent(requests.uploadSignaturesReq.id, requests.uploadSignaturesReq.type, JSON.stringify(signatures));
	}
	/** Encrypt and send a message (the test's sender; the bot itself sends nothing encrypted). */
	async sendEncrypted(roomId, members, content) {
		const { EncryptionSettings } = await import("@matrix-org/matrix-sdk-crypto-nodejs");
		await this.track(members);
		const users = members.map((u) => new UserId(u));
		const claim = await this.machine.getMissingSessions(users);
		if (claim) {
			const response = await this.request("POST", "/_matrix/client/v3/keys/claim", claim.body);
			await this.machine.markRequestAsSent(claim.id, claim.type, JSON.stringify(response));
		}
		for (const r of await this.machine.shareRoomKey(new RoomId(roomId), users, new EncryptionSettings())) {
			const response = await this.request("PUT", `/_matrix/client/v3/sendToDevice/${encodeURIComponent(r.eventType)}/${encodeURIComponent(r.txnId)}`, r.body);
			await this.machine.markRequestAsSent(r.id, r.type, JSON.stringify(response));
		}
		const encrypted = await this.machine.encryptRoomEvent(new RoomId(roomId), "m.room.message", JSON.stringify(content));
		return (await this.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/e2e${Date.now()}${this.txn++}`, encrypted)).event_id;
	}
	close() {
		this.machine?.close();
	}
};
export { CryptoClient, MatrixError };

//# sourceMappingURL=client.js.map