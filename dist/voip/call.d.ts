import { TypedEmitter } from "../util/emitter.js";
import { Logger } from "../util/logger.js";
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
  addEventListener(type: "icecandidate", listener: (event: {
    candidate: IceCandidateLike | null;
  }) => void): void;
  addEventListener(type: "iceconnectionstatechange" | "negotiationneeded", listener: () => void): void;
  close(): void;
}
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}
export type PeerConnectionFactory = (config: {
  iceServers: IceServer[];
}) => PeerConnectionLike;
export type CallState = "ringing" | "inviting" | "connecting" | "connected" | "ended";
export type CallHangupReason = "ice_timeout" | "ice_failed" | "invite_timeout" | "user_hangup" | "user_media_failed" | "user_busy" | "unknown_error" |
/** Not on the wire: the other side rejected the call, or another of our devices answered it. */
"rejected" | "answered_elsewhere" | "replaced";
/** Stream purposes and mute states (sdp_stream_metadata), by stream ID. */
export type StreamMetadata = Record<string, {
  purpose: "m.usermedia" | "m.screenshare" | string;
  audio_muted?: boolean;
  video_muted?: boolean;
}>;
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
export declare const INVITE_LIFETIME_MS = 90000;
export declare class MatrixCall extends TypedEmitter<CallEvents> {
  readonly callId: string;
  readonly roomId: string;
  readonly direction: "outbound" | "inbound";
  readonly partyId: string;
  /** For an inbound call: who called. For an outbound one: who answered (once someone did). */
  opponent?: {
    userId: string;
    partyId: string;
  };
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
  private readonly signalling;
  private readonly factory;
  private readonly logger;
  private readonly myUserId;
  private offer?;
  private remoteDescriptionSet;
  private readonly queuedRemoteCandidates;
  private readonly pendingCandidates;
  private candidateTimer?;
  private inviteTimer?;
  private makingOffer;
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
    opponent?: {
      userId: string;
      partyId: string;
    };
    offer?: SessionDescriptionLike;
    remoteStreamMetadata?: StreamMetadata;
  });
  /** Whether the other side offered video (an m=video section in its SDP). */
  get hasVideo(): boolean;
  private setState;
  private common;
  private createPeerConnection;
  /** Outbound: create the offer and send the invite. `setup` adds the local tracks. */
  place(setup: (pc: PeerConnectionLike) => void | Promise<void>, opts?: {
    streamMetadata?: StreamMetadata;
  }): Promise<void>;
  /** Inbound: answer. `setup` adds the local tracks. */
  answer(setup: (pc: PeerConnectionLike) => void | Promise<void>, opts?: {
    streamMetadata?: StreamMetadata;
  }): Promise<void>;
  /** Inbound, before answering: decline on every device (m.call.reject). */
  reject(): Promise<void>;
  /** End the call (m.call.hangup). */
  hangup(reason?: CallHangupReason): Promise<void>;
  /** Stop the call here without telling the other side (for example when another call replaces it). */
  end(reason: CallHangupReason): void;
  /** Tell the other side the stream metadata changed (mute, screen share), without renegotiating. */
  setStreamMetadata(metadata: StreamMetadata): Promise<void>;
  private onLocalCandidate;
  private scheduleCandidates;
  private sendCandidates;
  private flushRemoteCandidates;
  private addRemoteCandidate;
  private renegotiate;
  /** An m.call.* event of this call from someone else (or from another device of ours). */
  handle(type: string, content: Record<string, unknown>, sender: string): Promise<void>;
}
//# sourceMappingURL=call.d.ts.map