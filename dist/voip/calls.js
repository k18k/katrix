import { describeError } from "../util/logger.js";
import { TypedEmitter } from "../util/emitter.js";
import { MatrixCall, isStreamMetadata, sdpOf } from "./call.js";
// src/voip/calls.ts
/**
* Calls in rooms (https://spec.matrix.org/v1.19/client-server-api/#voice-over-ip), one-to-one.
* Needs a PeerConnectionFactory (ClientOptions.calls) to make or answer calls; without one,
* incoming calls are still signalled and can be rejected.
*/
var CallsApi = class extends TypedEmitter {
	api;
	logger;
	userId;
	factory;
	sendRoomEvent;
	makeId;
	calls = /* @__PURE__ */ new Map();
	turn;
	constructor(opts) {
		super();
		this.api = opts.api;
		this.logger = opts.logger;
		this.userId = opts.userId;
		this.factory = opts.factory;
		this.sendRoomEvent = opts.sendRoomEvent;
		this.makeId = opts.makeId;
	}
	/** The homeserver's TURN servers, cached until their credentials expire. */
	async turnServers() {
		if (this.turn && this.turn.expires > Date.now()) return this.turn.servers;
		try {
			const res = await this.api.endpoint("GET /v3/voip/turnServer", {}, {});
			const servers = res.uris?.length ? [{
				urls: res.uris,
				username: res.username,
				credential: res.password
			}] : [];
			this.turn = {
				servers,
				expires: Date.now() + Math.max(60, (res.ttl ?? 0) - 60) * 1e3
			};
			return servers;
		} catch (e) {
			this.logger.debug("no TURN servers", describeError(e));
			return [];
		}
	}
	/** Calls known to this client that have not ended. */
	active() {
		return [...this.calls.values()].filter((c) => c.state !== "ended");
	}
	get(callId) {
		return this.calls.get(callId);
	}
	newCall(opts) {
		if (!this.factory && opts.direction === "outbound") throw new Error("Calls need a PeerConnectionFactory (ClientOptions.calls.peerConnectionFactory)");
		const call = new MatrixCall({
			...opts,
			myUserId: this.userId,
			logger: this.logger,
			factory: this.factory ?? (() => {
				throw new Error("Calls need a PeerConnectionFactory (ClientOptions.calls.peerConnectionFactory)");
			}),
			signalling: {
				send: async (type, content) => {
					await this.sendRoomEvent(opts.roomId, type, content);
				},
				iceServers: () => this.turnServers()
			}
		});
		this.calls.set(call.callId, call);
		return call;
	}
	/**
	* Call a room (it should be a direct chat: anyone in the room can answer). `setup` adds the
	* local tracks to the peer connection before the offer is made. `invitee` names the user the
	* call is for.
	*/
	async place(roomId, setup, opts = {}) {
		const call = this.newCall({
			callId: this.makeId(),
			roomId,
			direction: "outbound",
			partyId: this.makeId(),
			invitee: opts.invitee
		});
		await call.place(setup, opts);
		return call;
	}
	/**
	* The m.call.* events of one sync, in timeline order, after decryption: whole syncs at once,
	* so an invite already hung up or answered elsewhere in the same sync never rings (spec).
	*/
	async handleEvents(events) {
		const rung = [];
		for (const { event, room } of events) try {
			const call = await this.handleEvent(event, room);
			if (call) rung.push(call);
		} catch (e) {
			this.logger.warn("a call event failed", describeError(e));
		}
		for (const call of rung) if (call.state === "ringing") this.emit("incoming", call);
	}
	/** One m.call.* event; returns a new ringing call (to signal once the sync is done). */
	async handleEvent(event, room) {
		const c = event.content;
		if (!event.type.startsWith("m.call.") || typeof c.call_id !== "string" || !event.sender) return void 0;
		const existing = this.calls.get(c.call_id);
		if (event.type !== "m.call.invite") {
			await existing?.handle(event.type, c, event.sender);
			return;
		}
		const offerSdp = sdpOf(c.offer);
		if (existing || typeof c.party_id !== "string" || offerSdp === void 0) return void 0;
		if (event.sender === this.userId) return void 0;
		if (typeof c.invitee === "string" && c.invitee !== this.userId) return void 0;
		const lifetime = typeof c.lifetime === "number" ? c.lifetime : 0;
		if ((typeof event.unsigned.age === "number" ? event.unsigned.age : Date.now() - (event.originServerTs ?? 0)) >= lifetime) return void 0;
		if (room.state.get("m.room.join_rules")?.content.join_rule === "public") {
			this.logger.info("not ringing for a call in a public room", { roomId: room.roomId });
			return;
		}
		const call = this.newCall({
			callId: c.call_id,
			roomId: room.roomId,
			direction: "inbound",
			partyId: this.makeId(),
			opponent: {
				userId: event.sender,
				partyId: c.party_id
			},
			offer: {
				type: "offer",
				sdp: offerSdp
			},
			remoteStreamMetadata: isStreamMetadata(c.sdp_stream_metadata) ? c.sdp_stream_metadata : void 0
		});
		for (const other of this.active()) {
			if (other === call || other.roomId !== room.roomId || other.direction !== "outbound" || other.state !== "inviting") continue;
			if (call.callId < other.callId) {
				await other.hangup("replaced");
				if (other.localSetup) {
					await call.answer(other.localSetup);
					return;
				}
			} else {
				call.end("replaced");
				return;
			}
		}
		return call;
	}
};
export { CallsApi };

//# sourceMappingURL=calls.js.map