import { ToDeviceEvent } from "../../shared/events.js";
import { MatrixHttpApi } from "../../http/api.js";
import { MatrixEvent } from "../../models/event.js";
import { TypedEmitter } from "../../util/emitter.js";
import { VerificationContext, VerificationRequest } from "./request.js";
export interface VerificationManagerEvents {
  /** Another user or device asks to verify: show it, then accept() or cancel(). */
  request: [request: VerificationRequest];
}
/**
 * Key verification between devices (https://spec.matrix.org/v1.19/client-server-api/#device-verification):
 * to-device for the user's own devices, in a room for other users, as the spec recommends.
 * Messages are routed to their VerificationRequest by transaction ID or by the request event.
 */
export declare class VerificationManager extends TypedEmitter<VerificationManagerEvents> {
  private readonly ctx;
  private readonly api;
  private readonly txnId;
  private readonly sendRoomEvent;
  private readonly byTxn;
  private readonly byEvent;
  constructor(opts: {
    ctx: VerificationContext;
    api: MatrixHttpApi;
    txnId: () => string;
    sendRoomEvent: (roomId: string, type: string, content: Record<string, unknown>) => Promise<string>;
  });
  /** The verifications in progress or recently finished. */
  requests(): VerificationRequest[];
  private toDeviceChannel;
  private roomChannel;
  /**
   * Verify another device of this user (to-device): all of them, or one. The first that accepts
   * gets the verification; the others are told it was taken.
   */
  requestOwnDeviceVerification(deviceId?: string): Promise<VerificationRequest>;
  /** Verify another user, in a room with them (preferably the direct chat). */
  requestUserVerification(roomId: string, userId: string): Promise<VerificationRequest>;
  /** A to-device event from /sync (plaintext or decrypted). */
  handleToDevice(event: ToDeviceEvent): Promise<void>;
  /** A room event (decrypted if it was encrypted) that may belong to a verification. */
  handleRoomEvent(event: MatrixEvent): Promise<void>;
}
//# sourceMappingURL=manager.d.ts.map