import type { MatrixHttpApi } from "../http/api.ts";
import type { MatrixEvent } from "../models/event.ts";
import type { Room } from "../models/room.ts";
import { TypedEmitter } from "../util/emitter.ts";
import { describeError, type Logger } from "../util/logger.ts";
import { MatrixCall, type IceServer, type PeerConnectionFactory, type PeerConnectionLike, type StreamMetadata } from "./call.ts";

export interface CallsEvents {
  /**
   * A call is ringing for this user: answer(), reject(), or ignore it (it then stops when the
   * caller hangs up or the invite expires). Not emitted for invites in public rooms (the spec
   * recommends not ringing there) or invites meant for someone else.
   */
  incoming: [call: MatrixCall];
}

/**
 * Calls in rooms (https://spec.matrix.org/v1.19/client-server-api/#voice-over-ip), one-to-one.
 * Needs a PeerConnectionFactory (ClientOptions.calls) to make or answer calls; without one,
 * incoming calls are still signalled and can be rejected.
 */
export class CallsApi extends TypedEmitter<CallsEvents> {
  private readonly api: MatrixHttpApi;
  private readonly logger: Logger;
  private readonly userId: string;
  private readonly factory?: PeerConnectionFactory;
  private readonly sendRoomEvent: (roomId: string, type: string, content: Record<string, unknown>) => Promise<string>;
  private readonly makeId: () => string;
  private readonly calls = new Map<string, MatrixCall>();
  private turn?: { servers: IceServer[]; expires: number };

  constructor(opts: {
    api: MatrixHttpApi;
    logger: Logger;
    userId: string;
    factory?: PeerConnectionFactory;
    sendRoomEvent: (roomId: string, type: string, content: Record<string, unknown>) => Promise<string>;
    makeId: () => string;
  }) {
    super();
    this.api = opts.api;
    this.logger = opts.logger;
    this.userId = opts.userId;
    this.factory = opts.factory;
    this.sendRoomEvent = opts.sendRoomEvent;
    this.makeId = opts.makeId;
  }

  /** The homeserver's TURN servers, cached until their credentials expire. */
  async turnServers(): Promise<IceServer[]> {
    if (this.turn && this.turn.expires > Date.now()) return this.turn.servers;
    try {
      const res = await this.api.endpoint("GET /v3/voip/turnServer", {}, {});
      const servers = res.uris?.length ? [{ urls: res.uris, username: res.username, credential: res.password }] : [];
      this.turn = { servers, expires: Date.now() + Math.max(60, (res.ttl ?? 0) - 60) * 1000 };
      return servers;
    } catch (e) {
      this.logger.debug("no TURN servers", describeError(e));
      return [];
    }
  }

  /** Calls known to this client that have not ended. */
  active(): MatrixCall[] {
    return [...this.calls.values()].filter((c) => c.state !== "ended");
  }

  get(callId: string): MatrixCall | undefined {
    return this.calls.get(callId);
  }

  private newCall(opts: {
    callId: string;
    roomId: string;
    direction: "outbound" | "inbound";
    partyId: string;
    invitee?: string;
    opponent?: { userId: string; partyId: string };
    offer?: { type: "offer"; sdp: string };
    remoteStreamMetadata?: StreamMetadata;
  }): MatrixCall {
    if (!this.factory && opts.direction === "outbound")
      throw new Error("Calls need a PeerConnectionFactory (ClientOptions.calls.peerConnectionFactory)");
    const call = new MatrixCall({
      ...opts,
      myUserId: this.userId,
      logger: this.logger,
      factory:
        this.factory ??
        (() => {
          throw new Error("Calls need a PeerConnectionFactory (ClientOptions.calls.peerConnectionFactory)");
        }),
      signalling: {
        send: async (type, content) => {
          await this.sendRoomEvent(opts.roomId, type, content);
        },
        iceServers: () => this.turnServers(),
      },
    });
    this.calls.set(call.callId, call);
    return call;
  }

  /**
   * Call a room (it should be a direct chat: anyone in the room can answer). `setup` adds the
   * local tracks to the peer connection before the offer is made. `invitee` names the user the
   * call is for.
   */
  async place(
    roomId: string,
    setup: (pc: PeerConnectionLike) => void | Promise<void>,
    opts: { invitee?: string; streamMetadata?: StreamMetadata } = {},
  ): Promise<MatrixCall> {
    const call = this.newCall({ callId: this.makeId(), roomId, direction: "outbound", partyId: this.makeId(), invitee: opts.invitee });
    await call.place(setup, opts);
    return call;
  }

  /**
   * The m.call.* events of one sync, in timeline order, after decryption: whole syncs at once,
   * so an invite already hung up or answered elsewhere in the same sync never rings (spec).
   */
  async handleEvents(events: Array<{ event: MatrixEvent; room: Room }>): Promise<void> {
    const rung: MatrixCall[] = [];
    for (const { event, room } of events) {
      try {
        const call = await this.handleEvent(event, room);
        if (call) rung.push(call);
      } catch (e) {
        this.logger.warn("a call event failed", describeError(e));
      }
    }
    for (const call of rung) if (call.state === "ringing") this.emit("incoming", call);
  }

  /** One m.call.* event; returns a new ringing call (to signal once the sync is done). */
  private async handleEvent(event: MatrixEvent, room: Room): Promise<MatrixCall | undefined> {
    const c = event.content as Record<string, any>;
    if (!event.type.startsWith("m.call.") || typeof c.call_id !== "string" || !event.sender) return undefined;
    const existing = this.calls.get(c.call_id);
    if (event.type !== "m.call.invite") {
      await existing?.handle(event.type, c, event.sender);
      return undefined;
    }
    if (existing || typeof c.party_id !== "string" || typeof c.offer?.sdp !== "string") return undefined;
    // Our own invite, from another device or coming back through /sync.
    if (event.sender === this.userId) return undefined;
    if (typeof c.invitee === "string" && c.invitee !== this.userId) return undefined;
    // Liveness by the server's `age`, so wrong device clocks do not matter.
    const lifetime = typeof c.lifetime === "number" ? c.lifetime : 0;
    const age = typeof event.unsigned.age === "number" ? event.unsigned.age : Date.now() - (event.originServerTs ?? 0);
    if (age >= lifetime) return undefined;
    if (room.state.get("m.room.join_rules")?.content.join_rule === "public") {
      this.logger.info("not ringing for a call in a public room", { roomId: room.roomId });
      return undefined;
    }
    const call = this.newCall({
      callId: c.call_id,
      roomId: room.roomId,
      direction: "inbound",
      partyId: this.makeId(),
      opponent: { userId: event.sender, partyId: c.party_id },
      offer: { type: "offer", sdp: c.offer.sdp },
      remoteStreamMetadata: c.sdp_stream_metadata,
    });
    // Glare: our own outbound call to this room, still unanswered. The call with the lesser ID
    // wins; if it is the incoming one, our outbound call gives way and the app answers this one.
    for (const other of this.active()) {
      if (other === call || other.roomId !== room.roomId || other.direction !== "outbound" || other.state !== "inviting") continue;
      if (call.callId < other.callId) {
        // The spec: accept the incoming call on the user's behalf, with the media of the call
        // it replaces, so it looks as if the other side had answered.
        await other.hangup("replaced");
        if (other.localSetup) {
          await call.answer(other.localSetup);
          return undefined;
        }
      } else {
        call.end("replaced");
        return undefined;
      }
    }
    return call;
  }
}
