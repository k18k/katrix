import { MatrixHttpApi } from "../http/api.js";
import { MatrixEvent } from "../models/event.js";
import { Room } from "../models/room.js";
import { TypedEmitter } from "../util/emitter.js";
import { Logger } from "../util/logger.js";
import { IceServer, MatrixCall, PeerConnectionFactory, PeerConnectionLike, StreamMetadata } from "./call.js";
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
export declare class CallsApi extends TypedEmitter<CallsEvents> {
  private readonly api;
  private readonly logger;
  private readonly userId;
  private readonly factory?;
  private readonly sendRoomEvent;
  private readonly makeId;
  private readonly calls;
  private turn?;
  constructor(opts: {
    api: MatrixHttpApi;
    logger: Logger;
    userId: string;
    factory?: PeerConnectionFactory;
    sendRoomEvent: (roomId: string, type: string, content: Record<string, unknown>) => Promise<string>;
    makeId: () => string;
  });
  /** The homeserver's TURN servers, cached until their credentials expire. */
  turnServers(): Promise<IceServer[]>;
  /** Calls known to this client that have not ended. */
  active(): MatrixCall[];
  get(callId: string): MatrixCall | undefined;
  private newCall;
  /**
   * Call a room (it should be a direct chat: anyone in the room can answer). `setup` adds the
   * local tracks to the peer connection before the offer is made. `invitee` names the user the
   * call is for.
   */
  place(roomId: string, setup: (pc: PeerConnectionLike) => void | Promise<void>, opts?: {
    invitee?: string;
    streamMetadata?: StreamMetadata;
  }): Promise<MatrixCall>;
  /**
   * The m.call.* events of one sync, in timeline order, after decryption: whole syncs at once,
   * so an invite already hung up or answered elsewhere in the same sync never rings (spec).
   */
  handleEvents(events: Array<{
    event: MatrixEvent;
    room: Room;
  }>): Promise<void>;
  /** One m.call.* event; returns a new ringing call (to signal once the sync is done). */
  private handleEvent;
}
//# sourceMappingURL=calls.d.ts.map