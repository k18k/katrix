import { clearTimer, setTimer } from "../platform.js";
import { describeError } from "../util/logger.js";
import { isObject } from "../shared/json.js";
import { TypedEmitter } from "../util/emitter.js";
// src/voip/call.ts
function isStreamMetadata(value) {
	return isObject(value) && Object.values(value).every((m) => isObject(m) && typeof m.purpose === "string" && (m.audio_muted === void 0 || typeof m.audio_muted === "boolean") && (m.video_muted === void 0 || typeof m.video_muted === "boolean"));
}
function isIceCandidate(value) {
	return isObject(value) && typeof value.candidate === "string" && (value.sdpMid === void 0 || value.sdpMid === null || typeof value.sdpMid === "string") && (value.sdpMLineIndex === void 0 || value.sdpMLineIndex === null || typeof value.sdpMLineIndex === "number");
}
function sdpOf(value) {
	return isObject(value) && typeof value.sdp === "string" ? value.sdp : void 0;
}
/** The minimal recommended invite lifetime (spec: 90 seconds). */
const INVITE_LIFETIME_MS = 9e4;
/** Candidate batching (spec's suggested starting points). */
const BATCH_AFTER_INVITE_MS = 2e3;
const BATCH_AFTER_ANSWER_MS = 500;
var MatrixCall = class extends TypedEmitter {
	callId;
	roomId;
	direction;
	partyId;
	/** For an inbound call: who called. For an outbound one: who answered (once someone did). */
	opponent;
	/** For an outbound call: the user it is for (`invitee`), if one. */
	invitee;
	state;
	hangupReason;
	/** The peer connection, once the call has one (outbound: at once; inbound: when answered). */
	peerConnection;
	/** The other party's sdp_stream_metadata, if it sends one. */
	remoteStreamMetadata;
	/** The setup an outbound call was placed with (glare: the call that replaces it reuses it). */
	localSetup;
	signalling;
	factory;
	logger;
	myUserId;
	offer;
	remoteDescriptionSet = false;
	queuedRemoteCandidates = [];
	pendingCandidates = [];
	candidateTimer;
	inviteTimer;
	makingOffer = false;
	constructor(opts) {
		super();
		this.callId = opts.callId;
		this.roomId = opts.roomId;
		this.direction = opts.direction;
		this.partyId = opts.partyId;
		this.myUserId = opts.myUserId;
		this.signalling = opts.signalling;
		this.factory = opts.factory;
		this.logger = opts.logger;
		this.invitee = opts.invitee;
		this.opponent = opts.opponent;
		this.offer = opts.offer;
		this.remoteStreamMetadata = opts.remoteStreamMetadata;
		this.state = opts.direction === "inbound" ? "ringing" : "inviting";
	}
	/** Whether the other side offered video (an m=video section in its SDP). */
	get hasVideo() {
		return /^m=video /m.test(this.offer?.sdp ?? "");
	}
	setState(state) {
		const previous = this.state;
		if (previous === state) return;
		this.state = state;
		this.emit("state", state, previous);
	}
	common() {
		return {
			call_id: this.callId,
			party_id: this.partyId,
			version: "1"
		};
	}
	async createPeerConnection(setup) {
		const pc = this.factory({ iceServers: await this.signalling.iceServers().catch(() => []) });
		this.peerConnection = pc;
		pc.addEventListener("icecandidate", (e) => this.onLocalCandidate(e.candidate));
		pc.addEventListener("iceconnectionstatechange", () => {
			const s = pc.iceConnectionState;
			if (s === "connected" || s === "completed") this.setState("connected");
			else if (s === "failed") this.hangup("ice_failed");
		});
		pc.addEventListener("negotiationneeded", () => void this.renegotiate());
		await setup(pc);
		return pc;
	}
	/** Outbound: create the offer and send the invite. `setup` adds the local tracks. */
	async place(setup, opts = {}) {
		this.localSetup = setup;
		const pc = await this.createPeerConnection(setup);
		this.makingOffer = true;
		try {
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			await this.signalling.send("m.call.invite", {
				...this.common(),
				lifetime: INVITE_LIFETIME_MS,
				offer: {
					type: offer.type,
					sdp: offer.sdp
				},
				...this.invitee ? { invitee: this.invitee } : {},
				...opts.streamMetadata ? { sdp_stream_metadata: opts.streamMetadata } : {}
			});
		} finally {
			this.makingOffer = false;
		}
		this.scheduleCandidates(BATCH_AFTER_INVITE_MS);
		this.inviteTimer = setTimer(() => {
			if (this.state === "inviting") this.hangup("invite_timeout");
		}, INVITE_LIFETIME_MS);
	}
	/** Inbound: answer. `setup` adds the local tracks. */
	async answer(setup, opts = {}) {
		if (this.direction !== "inbound" || this.state !== "ringing" || !this.offer) throw new Error("Only a ringing call can be answered");
		this.setState("connecting");
		try {
			const pc = await this.createPeerConnection(setup);
			await pc.setRemoteDescription(this.offer);
			this.remoteDescriptionSet = true;
			await this.flushRemoteCandidates();
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);
			await this.signalling.send("m.call.answer", {
				...this.common(),
				answer: {
					type: answer.type,
					sdp: answer.sdp
				},
				...opts.streamMetadata ? { sdp_stream_metadata: opts.streamMetadata } : {}
			});
			this.scheduleCandidates(BATCH_AFTER_ANSWER_MS);
		} catch (e) {
			this.logger.warn("answering a call failed", describeError(e));
			await this.hangup("user_media_failed");
			throw e;
		}
	}
	/** Inbound, before answering: decline on every device (m.call.reject). */
	async reject() {
		if (this.direction !== "inbound" || this.state !== "ringing") throw new Error("Only a ringing call can be rejected");
		this.end("rejected");
		await this.signalling.send("m.call.reject", this.common());
	}
	/** End the call (m.call.hangup). */
	async hangup(reason = "user_hangup") {
		if (this.state === "ended") return;
		const wire = [
			"ice_timeout",
			"ice_failed",
			"invite_timeout",
			"user_hangup",
			"user_media_failed",
			"user_busy",
			"unknown_error"
		].includes(reason) ? reason : "user_hangup";
		this.end(reason);
		await this.signalling.send("m.call.hangup", {
			...this.common(),
			reason: wire
		}).catch((e) => this.logger.warn("could not send a hangup", describeError(e)));
	}
	/** Stop the call here without telling the other side (for example when another call replaces it). */
	end(reason) {
		if (this.state === "ended") return;
		this.hangupReason = reason;
		if (this.candidateTimer !== void 0) clearTimer(this.candidateTimer);
		if (this.inviteTimer !== void 0) clearTimer(this.inviteTimer);
		try {
			this.peerConnection?.close();
		} catch {}
		this.setState("ended");
	}
	/** Tell the other side the stream metadata changed (mute, screen share), without renegotiating. */
	async setStreamMetadata(metadata) {
		await this.signalling.send("m.call.sdp_stream_metadata_changed", {
			...this.common(),
			sdp_stream_metadata: metadata
		});
	}
	onLocalCandidate(candidate) {
		this.pendingCandidates.push(candidate ? {
			candidate: candidate.candidate,
			sdpMid: candidate.sdpMid,
			sdpMLineIndex: candidate.sdpMLineIndex
		} : { candidate: "" });
		if (!candidate) this.sendCandidates();
		else if (this.candidateTimer === void 0 && this.state !== "ringing") this.scheduleCandidates(BATCH_AFTER_ANSWER_MS);
	}
	scheduleCandidates(ms) {
		if (this.candidateTimer !== void 0) return;
		this.candidateTimer = setTimer(() => {
			this.candidateTimer = void 0;
			this.sendCandidates();
		}, ms);
	}
	async sendCandidates() {
		if (this.pendingCandidates.length === 0 || this.state === "ended") return;
		const candidates = this.pendingCandidates.splice(0);
		await this.signalling.send("m.call.candidates", {
			...this.common(),
			candidates
		}).catch((e) => this.logger.warn("could not send ICE candidates", describeError(e)));
	}
	async flushRemoteCandidates() {
		for (const c of this.queuedRemoteCandidates.splice(0)) await this.addRemoteCandidate(c);
	}
	async addRemoteCandidate(c) {
		try {
			await this.peerConnection.addIceCandidate(c);
		} catch (e) {
			this.logger.debug("an ICE candidate was refused", describeError(e));
		}
	}
	async renegotiate() {
		const pc = this.peerConnection;
		if (!pc || this.state !== "connected") return;
		this.makingOffer = true;
		try {
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			await this.signalling.send("m.call.negotiate", {
				...this.common(),
				lifetime: INVITE_LIFETIME_MS,
				description: {
					type: offer.type,
					sdp: offer.sdp
				}
			});
		} catch (e) {
			this.logger.warn("renegotiation failed", describeError(e));
		} finally {
			this.makingOffer = false;
		}
	}
	/** An m.call.* event of this call from someone else (or from another device of ours). */
	async handle(type, content, sender) {
		if (this.state === "ended") return;
		if (sender === this.myUserId && content.party_id === this.partyId) return;
		if (isStreamMetadata(content.sdp_stream_metadata)) {
			this.remoteStreamMetadata = content.sdp_stream_metadata;
			this.emit("streamMetadata", content.sdp_stream_metadata);
		}
		const fromOpponent = this.opponent !== void 0 && sender === this.opponent.userId && content.party_id === this.opponent.partyId;
		switch (type) {
			case "m.call.answer":
				if (this.direction === "inbound") {
					if (sender === this.myUserId && this.state === "ringing") this.end("answered_elsewhere");
					return;
				}
				const answerSdp = sdpOf(content.answer);
				if (this.opponent || this.state !== "inviting" || answerSdp === void 0 || typeof content.party_id !== "string") return;
				this.opponent = {
					userId: sender,
					partyId: content.party_id
				};
				if (this.inviteTimer !== void 0) clearTimer(this.inviteTimer);
				this.setState("connecting");
				await this.peerConnection.setRemoteDescription({
					type: "answer",
					sdp: answerSdp
				});
				this.remoteDescriptionSet = true;
				await this.flushRemoteCandidates();
				await this.signalling.send("m.call.select_answer", {
					...this.common(),
					selected_party_id: content.party_id
				});
				return;
			case "m.call.select_answer":
				if (this.direction === "inbound" && fromOpponent && content.selected_party_id !== this.partyId) this.end("answered_elsewhere");
				return;
			case "m.call.candidates":
				if (!Array.isArray(content.candidates)) return;
				if (this.opponent && !fromOpponent) return;
				for (const c of content.candidates) {
					if (!isIceCandidate(c)) continue;
					if (this.remoteDescriptionSet) await this.addRemoteCandidate(c);
					else this.queuedRemoteCandidates.push(c);
				}
				return;
			case "m.call.negotiate": {
				const d = content.description;
				const sdp = sdpOf(d);
				if (!fromOpponent || !this.peerConnection || !isObject(d) || sdp === void 0 || d.type !== "offer" && d.type !== "answer") return;
				const pc = this.peerConnection;
				const polite = this.direction === "inbound";
				if (d.type === "offer" && (this.makingOffer || pc.signalingState !== "stable") && !polite) return;
				await pc.setRemoteDescription({
					type: d.type,
					sdp
				});
				if (d.type === "offer") {
					const answer = await pc.createAnswer();
					await pc.setLocalDescription(answer);
					await this.signalling.send("m.call.negotiate", {
						...this.common(),
						lifetime: INVITE_LIFETIME_MS,
						description: {
							type: answer.type,
							sdp: answer.sdp
						}
					});
				}
				return;
			}
			case "m.call.reject":
				if (this.direction === "outbound" && !this.opponent) this.end("rejected");
				else if (this.direction === "inbound" && sender === this.myUserId && this.state === "ringing") this.end("rejected");
				return;
			case "m.call.hangup":
				if (fromOpponent || this.direction === "inbound" && this.opponent?.userId === sender && this.state === "ringing") this.end("user_hangup");
				return;
		}
	}
};
export { INVITE_LIFETIME_MS, MatrixCall, isStreamMetadata, sdpOf };

//# sourceMappingURL=call.js.map