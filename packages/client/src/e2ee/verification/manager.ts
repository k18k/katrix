import type { MatrixHttpApi } from "../../http/api.ts";
import type { MatrixEvent } from "../../models/event.ts";
import { TypedEmitter } from "../../util/emitter.ts";
import { describeError } from "../../util/logger.ts";
import type { ToDeviceEvent } from "@katrix/shared";
import { ALL_METHODS, VerificationRequest, type VerificationChannel, type VerificationContext } from "./request.ts";

/** Requests older than this are not shown (spec: 10 minutes after their timestamp). */
const REQUEST_LIFETIME_MS = 10 * 60_000;

const VERIFICATION_TYPES = new Set([
  "m.key.verification.request",
  "m.key.verification.ready",
  "m.key.verification.start",
  "m.key.verification.accept",
  "m.key.verification.key",
  "m.key.verification.mac",
  "m.key.verification.done",
  "m.key.verification.cancel",
]);

export interface VerificationManagerEvents {
  /** Another user or device asks to verify: show it, then accept() or cancel(). */
  request: [request: VerificationRequest];
}

/**
 * Key verification between devices (https://spec.matrix.org/v1.19/client-server-api/#device-verification):
 * to-device for the user's own devices, in a room for other users, as the spec recommends.
 * Messages are routed to their VerificationRequest by transaction ID or by the request event.
 */
export class VerificationManager extends TypedEmitter<VerificationManagerEvents> {
  private readonly ctx: VerificationContext;
  private readonly api: MatrixHttpApi;
  private readonly txnId: () => string;
  private readonly sendRoomEvent: (roomId: string, type: string, content: Record<string, unknown>) => Promise<string>;
  private readonly byTxn = new Map<string, VerificationRequest>();
  private readonly byEvent = new Map<string, VerificationRequest>();

  constructor(opts: {
    ctx: VerificationContext;
    api: MatrixHttpApi;
    txnId: () => string;
    sendRoomEvent: (roomId: string, type: string, content: Record<string, unknown>) => Promise<string>;
  }) {
    super();
    this.ctx = opts.ctx;
    this.api = opts.api;
    this.txnId = opts.txnId;
    this.sendRoomEvent = opts.sendRoomEvent;
  }

  /** The verifications in progress or recently finished. */
  requests(): VerificationRequest[] {
    return [...new Set([...this.byTxn.values(), ...this.byEvent.values()])];
  }

  private toDeviceChannel(transactionId: string, userId: string, deviceIds: string[]): VerificationChannel {
    let targets = deviceIds;
    return {
      kind: "to-device",
      transactionId,
      send: async (type, content) => {
        const full = { ...content, transaction_id: transactionId };
        await this.api.endpoint(
          "PUT /v3/sendToDevice/:eventType/:txnId",
          { eventType: type, txnId: this.txnId() },
          { body: { messages: { [userId]: Object.fromEntries(targets.map((d) => [d, full])) } } },
        );
        return full;
      },
      narrowTo: (deviceId) => {
        // The other devices that got the request are told it was answered elsewhere (spec: m.accepted).
        const others = targets.filter((d) => d !== deviceId && d !== "*");
        targets = [deviceId];
        if (others.length)
          void this.api
            .endpoint(
              "PUT /v3/sendToDevice/:eventType/:txnId",
              { eventType: "m.key.verification.cancel", txnId: this.txnId() },
              {
                body: {
                  messages: {
                    [userId]: Object.fromEntries(
                      others.map((d) => [d, { transaction_id: transactionId, code: "m.accepted", reason: "Verified on another device" }]),
                    ),
                  },
                },
              },
            )
            .catch((e) => this.ctx.logger.warn("could not cancel the request at other devices", describeError(e)));
      },
    };
  }

  private roomChannel(roomId: string, eventId: string): VerificationChannel {
    return {
      kind: "room",
      transactionId: eventId,
      send: async (type, content) => {
        const full = { ...content, "m.relates_to": { rel_type: "m.reference", event_id: eventId } };
        await this.sendRoomEvent(roomId, type, full);
        return full;
      },
    };
  }

  /**
   * Verify another device of this user (to-device): all of them, or one. The first that accepts
   * gets the verification; the others are told it was taken.
   */
  async requestOwnDeviceVerification(deviceId?: string): Promise<VerificationRequest> {
    await this.ctx.devices.refresh([this.ctx.userId]);
    const devices = deviceId
      ? [deviceId]
      : (await this.ctx.devices.devices(this.ctx.userId)).map((d) => d.deviceId).filter((d) => d !== this.ctx.deviceId);
    if (devices.length === 0) throw new Error("There is no other device to verify with");
    const transactionId = this.txnId();
    const request = new VerificationRequest(this.ctx, this.toDeviceChannel(transactionId, this.ctx.userId, devices), {
      initiatedByMe: true,
      otherUserId: this.ctx.userId,
      otherDeviceId: deviceId,
    });
    this.byTxn.set(transactionId, request);
    await request.channel.send("m.key.verification.request", {
      from_device: this.ctx.deviceId,
      methods: ALL_METHODS,
      timestamp: Date.now(),
    });
    return request;
  }

  /** Verify another user, in a room with them (preferably the direct chat). */
  async requestUserVerification(roomId: string, userId: string): Promise<VerificationRequest> {
    const eventId = await this.sendRoomEvent(roomId, "m.room.message", {
      msgtype: "m.key.verification.request",
      body: `${this.ctx.userId} is asking to verify your key, but your client does not support in-chat key verification.`,
      from_device: this.ctx.deviceId,
      methods: ALL_METHODS,
      to: userId,
    });
    // Our own request may already have come back through /sync and been ignored (ours).
    const request = new VerificationRequest(this.ctx, this.roomChannel(roomId, eventId), { initiatedByMe: true, otherUserId: userId });
    this.byEvent.set(eventId, request);
    return request;
  }

  /** A to-device event from /sync (plaintext or decrypted). */
  async handleToDevice(event: ToDeviceEvent): Promise<void> {
    if (!VERIFICATION_TYPES.has(event.type)) return;
    const c = event.content as Record<string, any>;
    const txn = c.transaction_id;
    if (typeof txn !== "string") return;
    let request = this.byTxn.get(txn);
    if (event.type === "m.key.verification.request") {
      if (request || typeof c.from_device !== "string" || !Array.isArray(c.methods)) return;
      if (typeof c.timestamp === "number" && Math.abs(Date.now() - c.timestamp) > REQUEST_LIFETIME_MS) return;
      request = new VerificationRequest(this.ctx, this.toDeviceChannel(txn, event.sender, [c.from_device]), {
        initiatedByMe: false,
        otherUserId: event.sender,
        otherDeviceId: c.from_device,
      });
      request.theirMethods = c.methods.filter((m: unknown): m is string => typeof m === "string");
      this.byTxn.set(txn, request);
      this.emit("request", request);
      return;
    }
    if (!request) {
      // A start without a request (deprecated, still handled), else an unknown transaction.
      if (event.type === "m.key.verification.start" && typeof c.from_device === "string") {
        request = new VerificationRequest(this.ctx, this.toDeviceChannel(txn, event.sender, [c.from_device]), {
          initiatedByMe: false,
          otherUserId: event.sender,
          otherDeviceId: c.from_device,
        });
        request.phase = "ready";
        request.theirMethods = [c.method];
        this.byTxn.set(txn, request);
        this.emit("request", request);
      } else {
        if (event.type !== "m.key.verification.cancel" && typeof c.from_device === "string")
          await this.toDeviceChannel(txn, event.sender, [c.from_device])
            .send("m.key.verification.cancel", { code: "m.unknown_transaction", reason: "Unknown verification" })
            .catch(() => {});
        return;
      }
    }
    await request.handle(event.type, c, event.sender);
  }

  /** A room event (decrypted if it was encrypted) that may belong to a verification. */
  async handleRoomEvent(event: MatrixEvent): Promise<void> {
    const c = event.content as Record<string, any>;
    if (!event.sender || !event.roomId) return;
    if (event.type === "m.room.message" && c.msgtype === "m.key.verification.request") {
      if (!event.eventId || this.byEvent.has(event.eventId) || c.to !== this.ctx.userId || event.sender === this.ctx.userId) return;
      if (event.originServerTs !== undefined && Date.now() - event.originServerTs > REQUEST_LIFETIME_MS) return;
      if (typeof c.from_device !== "string" || !Array.isArray(c.methods)) return;
      const request = new VerificationRequest(this.ctx, this.roomChannel(event.roomId, event.eventId), {
        initiatedByMe: false,
        otherUserId: event.sender,
        otherDeviceId: c.from_device,
      });
      request.theirMethods = c.methods.filter((m: unknown): m is string => typeof m === "string");
      this.byEvent.set(event.eventId, request);
      this.emit("request", request);
      return;
    }
    if (!VERIFICATION_TYPES.has(event.type)) return;
    const rel = c["m.relates_to"];
    const request = rel?.rel_type === "m.reference" && typeof rel.event_id === "string" ? this.byEvent.get(rel.event_id) : undefined;
    if (!request) return;
    // Our own messages come back through /sync: only those from our other devices matter.
    if (event.sender === this.ctx.userId && c.from_device === this.ctx.deviceId) return;
    if (event.sender === this.ctx.userId && c.from_device === undefined && request.otherUserId !== this.ctx.userId) return;
    await request.handle(event.type, c, event.sender);
  }
}
