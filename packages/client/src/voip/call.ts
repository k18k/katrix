import { clearTimer, setTimer } from "../platform.ts";
import { TypedEmitter } from "../util/emitter.ts";
import { describeError, type Logger } from "../util/logger.ts";

// Voice and video calls (https://spec.matrix.org/v1.19/client-server-api/#voice-over-ip): the
// m.call.* signalling and the call's state machine. Media is WebRTC, which the SDK does not
// implement: the app passes a factory for standard RTCPeerConnection objects (the browser's,
// or react-native-webrtc's), and adds its tracks to each call's peer connection.

export interface SessionDescriptionLike {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp?: string;
}

export interface IceCandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

/** The part of RTCPeerConnection the calls use. */
export interface PeerConnectionLike {
  createOffer(): Promise<SessionDescriptionLike>;
  createAnswer(): Promise<SessionDescriptionLike>;
  setLocalDescription(description: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>;
  addIceCandidate(candidate: IceCandidateLike): Promise<void>;
  readonly signalingState: string;
  readonly iceConnectionState: string;
  addEventListener(type: "icecandidate", listener: (event: { candidate: IceCandidateLike | null }) => void): void;
  addEventListener(type: "iceconnectionstatechange" | "negotiationneeded", listener: () => void): void;
  close(): void;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export type PeerConnectionFactory = (config: { iceServers: IceServer[] }) => PeerConnectionLike;

export type CallState = "ringing" | "inviting" | "connecting" | "connected" | "ended";

export type CallHangupReason =
  | "ice_timeout"
  | "ice_failed"
  | "invite_timeout"
  | "user_hangup"
  | "user_media_failed"
  | "user_busy"
  | "unknown_error"
  /** Not on the wire: the other side rejected the call, or another of our devices answered it. */
  | "rejected"
  | "answered_elsewhere"
  | "replaced";

/** Stream purposes and mute states (sdp_stream_metadata), by stream ID. */
export type StreamMetadata = Record<
  string,
  { purpose: "m.usermedia" | "m.screenshare" | string; audio_muted?: boolean; video_muted?: boolean }
>;

export interface CallEvents {
  state: [state: CallState, previous: CallState];
  /** The other party's stream metadata changed. */
  streamMetadata: [metadata: StreamMetadata];
}

/** How a call sends its signalling (room events, encrypted when the room is). */
export interface CallSignalling {
  send(type: string, content: Record<string, unknown>): Promise<void>;
  /** TURN servers from the homeserver. */
  iceServers(): Promise<IceServer[]>;
}

/** The minimal recommended invite lifetime (spec: 90 seconds). */
export const INVITE_LIFETIME_MS = 90_000;
/** Candidate batching (spec's suggested starting points). */
const BATCH_AFTER_INVITE_MS = 2000;
const BATCH_AFTER_ANSWER_MS = 500;

export class MatrixCall extends TypedEmitter<CallEvents> {
  readonly callId: string;
  readonly roomId: string;
  readonly direction: "outbound" | "inbound";
  readonly partyId: string;
  /** For an inbound call: who called. For an outbound one: who answered (once someone did). */
  opponent?: { userId: string; partyId: string };
  /** For an outbound call: the user it is for (`invitee`), if one. */
  readonly invitee?: string;
  state: CallState;
  hangupReason?: CallHangupReason;
  /** The peer connection, once the call has one (outbound: at once; inbound: when answered). */
  peerConnection?: PeerConnectionLike;
  /** The other party's sdp_stream_metadata, if it sends one. */
  remoteStreamMetadata?: StreamMetadata;
  /** The setup an outbound call was placed with (glare: the call that replaces it reuses it). */
  localSetup?: (pc: PeerConnectionLike) => void | Promise<void>;
  private readonly signalling: CallSignalling;
  private readonly factory: PeerConnectionFactory;
  private readonly logger: Logger;
  private readonly myUserId: string;
  private offer?: SessionDescriptionLike;
  private remoteDescriptionSet = false;
  private readonly queuedRemoteCandidates: IceCandidateLike[] = [];
  private readonly pendingCandidates: IceCandidateLike[] = [];
  private candidateTimer?: unknown;
  private inviteTimer?: unknown;
  private makingOffer = false;

  constructor(opts: {
    callId: string;
    roomId: string;
    direction: "outbound" | "inbound";
    partyId: string;
    myUserId: string;
    signalling: CallSignalling;
    factory: PeerConnectionFactory;
    logger: Logger;
    invitee?: string;
    opponent?: { userId: string; partyId: string };
    offer?: SessionDescriptionLike;
    remoteStreamMetadata?: StreamMetadata;
  }) {
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
  get hasVideo(): boolean {
    return /^m=video /m.test(this.offer?.sdp ?? "");
  }

  private setState(state: CallState): void {
    const previous = this.state;
    if (previous === state) return;
    this.state = state;
    this.emit("state", state, previous);
  }

  private common(): Record<string, unknown> {
    return { call_id: this.callId, party_id: this.partyId, version: "1" };
  }

  private async createPeerConnection(setup: (pc: PeerConnectionLike) => void | Promise<void>): Promise<PeerConnectionLike> {
    const pc = this.factory({ iceServers: await this.signalling.iceServers().catch(() => []) });
    this.peerConnection = pc;
    pc.addEventListener("icecandidate", (e) => this.onLocalCandidate(e.candidate));
    pc.addEventListener("iceconnectionstatechange", () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") this.setState("connected");
      else if (s === "failed") void this.hangup("ice_failed");
    });
    pc.addEventListener("negotiationneeded", () => void this.renegotiate());
    await setup(pc);
    return pc;
  }

  /** Outbound: create the offer and send the invite. `setup` adds the local tracks. */
  async place(setup: (pc: PeerConnectionLike) => void | Promise<void>, opts: { streamMetadata?: StreamMetadata } = {}): Promise<void> {
    this.localSetup = setup;
    const pc = await this.createPeerConnection(setup);
    this.makingOffer = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.signalling.send("m.call.invite", {
        ...this.common(),
        lifetime: INVITE_LIFETIME_MS,
        offer: { type: offer.type, sdp: offer.sdp },
        ...(this.invitee ? { invitee: this.invitee } : {}),
        ...(opts.streamMetadata ? { sdp_stream_metadata: opts.streamMetadata } : {}),
      });
    } finally {
      this.makingOffer = false;
    }
    this.scheduleCandidates(BATCH_AFTER_INVITE_MS);
    this.inviteTimer = setTimer(() => {
      if (this.state === "inviting") void this.hangup("invite_timeout");
    }, INVITE_LIFETIME_MS);
  }

  /** Inbound: answer. `setup` adds the local tracks. */
  async answer(setup: (pc: PeerConnectionLike) => void | Promise<void>, opts: { streamMetadata?: StreamMetadata } = {}): Promise<void> {
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
        answer: { type: answer.type, sdp: answer.sdp },
        ...(opts.streamMetadata ? { sdp_stream_metadata: opts.streamMetadata } : {}),
      });
      this.scheduleCandidates(BATCH_AFTER_ANSWER_MS);
    } catch (e) {
      this.logger.warn("answering a call failed", describeError(e));
      await this.hangup("user_media_failed");
      throw e;
    }
  }

  /** Inbound, before answering: decline on every device (m.call.reject). */
  async reject(): Promise<void> {
    if (this.direction !== "inbound" || this.state !== "ringing") throw new Error("Only a ringing call can be rejected");
    this.end("rejected");
    await this.signalling.send("m.call.reject", this.common());
  }

  /** End the call (m.call.hangup). */
  async hangup(reason: CallHangupReason = "user_hangup"): Promise<void> {
    if (this.state === "ended") return;
    const wire = ["ice_timeout", "ice_failed", "invite_timeout", "user_hangup", "user_media_failed", "user_busy", "unknown_error"].includes(
      reason,
    )
      ? reason
      : "user_hangup";
    this.end(reason);
    await this.signalling
      .send("m.call.hangup", { ...this.common(), reason: wire })
      .catch((e) => this.logger.warn("could not send a hangup", describeError(e)));
  }

  /** Stop the call here without telling the other side (for example when another call replaces it). */
  end(reason: CallHangupReason): void {
    if (this.state === "ended") return;
    this.hangupReason = reason;
    if (this.candidateTimer !== undefined) clearTimer(this.candidateTimer);
    if (this.inviteTimer !== undefined) clearTimer(this.inviteTimer);
    try {
      this.peerConnection?.close();
    } catch {
      // Already closed.
    }
    this.setState("ended");
  }

  /** Tell the other side the stream metadata changed (mute, screen share), without renegotiating. */
  async setStreamMetadata(metadata: StreamMetadata): Promise<void> {
    await this.signalling.send("m.call.sdp_stream_metadata_changed", { ...this.common(), sdp_stream_metadata: metadata });
  }

  // ─── Candidates ───────────────────────────────────────────────────────────

  private onLocalCandidate(candidate: IceCandidateLike | null): void {
    // A null candidate ends gathering: the spec's end-of-candidates is an empty candidate, sent at once.
    this.pendingCandidates.push(
      candidate ? { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex } : { candidate: "" },
    );
    if (!candidate) void this.sendCandidates();
    else if (this.candidateTimer === undefined && this.state !== "ringing") this.scheduleCandidates(BATCH_AFTER_ANSWER_MS);
  }

  private scheduleCandidates(ms: number): void {
    if (this.candidateTimer !== undefined) return;
    this.candidateTimer = setTimer(() => {
      this.candidateTimer = undefined;
      void this.sendCandidates();
    }, ms);
  }

  private async sendCandidates(): Promise<void> {
    if (this.pendingCandidates.length === 0 || this.state === "ended") return;
    const candidates = this.pendingCandidates.splice(0);
    await this.signalling
      .send("m.call.candidates", { ...this.common(), candidates })
      .catch((e) => this.logger.warn("could not send ICE candidates", describeError(e)));
  }

  private async flushRemoteCandidates(): Promise<void> {
    for (const c of this.queuedRemoteCandidates.splice(0)) await this.addRemoteCandidate(c);
  }

  private async addRemoteCandidate(c: IceCandidateLike): Promise<void> {
    try {
      await this.peerConnection!.addIceCandidate(c);
    } catch (e) {
      this.logger.debug("an ICE candidate was refused", describeError(e));
    }
  }

  // ─── Renegotiation (perfect negotiation: the callee is polite) ────────────

  private async renegotiate(): Promise<void> {
    const pc = this.peerConnection;
    if (!pc || this.state !== "connected") return;
    this.makingOffer = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.signalling.send("m.call.negotiate", {
        ...this.common(),
        lifetime: INVITE_LIFETIME_MS,
        description: { type: offer.type, sdp: offer.sdp },
      });
    } catch (e) {
      this.logger.warn("renegotiation failed", describeError(e));
    } finally {
      this.makingOffer = false;
    }
  }

  // ─── Incoming signalling ──────────────────────────────────────────────────

  /** An m.call.* event of this call from someone else (or from another device of ours). */
  async handle(type: string, content: Record<string, any>, sender: string): Promise<void> {
    if (this.state === "ended") return;
    const fromUs = sender === this.myUserId && content.party_id === this.partyId;
    if (fromUs) return;
    if (content.sdp_stream_metadata && typeof content.sdp_stream_metadata === "object") {
      this.remoteStreamMetadata = content.sdp_stream_metadata;
      this.emit("streamMetadata", content.sdp_stream_metadata);
    }
    const fromOpponent = this.opponent !== undefined && sender === this.opponent.userId && content.party_id === this.opponent.partyId;
    switch (type) {
      case "m.call.answer":
        if (this.direction === "inbound") {
          // Another device of ours answered first.
          if (sender === this.myUserId && this.state === "ringing") this.end("answered_elsewhere");
          return;
        }
        if (this.opponent || this.state !== "inviting" || typeof content.answer?.sdp !== "string") return;
        this.opponent = { userId: sender, partyId: content.party_id };
        if (this.inviteTimer !== undefined) clearTimer(this.inviteTimer);
        this.setState("connecting");
        await this.peerConnection!.setRemoteDescription({ type: "answer", sdp: content.answer.sdp });
        this.remoteDescriptionSet = true;
        await this.flushRemoteCandidates();
        await this.signalling.send("m.call.select_answer", { ...this.common(), selected_party_id: content.party_id });
        return;
      case "m.call.select_answer":
        if (this.direction === "inbound" && fromOpponent && content.selected_party_id !== this.partyId) this.end("answered_elsewhere");
        return;
      case "m.call.candidates": {
        if (!Array.isArray(content.candidates)) return;
        // Before an answer is picked, candidates of the caller (inbound) are the only ones that count.
        if (this.opponent && !fromOpponent) return;
        for (const c of content.candidates) {
          if (typeof c?.candidate !== "string") continue;
          if (this.remoteDescriptionSet) await this.addRemoteCandidate(c);
          else this.queuedRemoteCandidates.push(c);
        }
        return;
      }
      case "m.call.negotiate": {
        const d = content.description;
        if (!fromOpponent || !this.peerConnection || typeof d?.sdp !== "string") return;
        const pc = this.peerConnection;
        const polite = this.direction === "inbound";
        const collision = d.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
        if (collision && !polite) return;
        await pc.setRemoteDescription({ type: d.type, sdp: d.sdp });
        if (d.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await this.signalling.send("m.call.negotiate", {
            ...this.common(),
            lifetime: INVITE_LIFETIME_MS,
            description: { type: answer.type, sdp: answer.sdp },
          });
        }
        return;
      }
      case "m.call.reject":
        if (this.direction === "outbound" && !this.opponent) this.end("rejected");
        else if (this.direction === "inbound" && sender === this.myUserId && this.state === "ringing") this.end("rejected");
        return;
      case "m.call.hangup":
        if (fromOpponent || (this.direction === "inbound" && this.opponent?.userId === sender && this.state === "ringing"))
          this.end("user_hangup");
        return;
    }
  }
}
