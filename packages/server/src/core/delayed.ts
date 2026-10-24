import { errors, MatrixError } from "#core/errors.ts";
import { randomString } from "#core/crypto.ts";
import type { Homeserver } from "#homeserver.ts";
import { UNSTABLE } from "#core/m.ts";

/** When a delayed event whose send failed is tried again. */
const RETRY_MS = 10_000;
/** Device under which delayed events are sent, for their transaction IDs (no real device has this ID). */
const DELAYED_DEVICE = "\u0000delayed";

export interface DelayedEventsOptions {
  /** Maximum delay a client may request, in ms. Default: 24 hours. */
  maxDelayMs?: number;
  /** Maximum pending delayed events per user. Default: 100. */
  maxPerUser?: number;
}

/**
 * Delayed events (MSC4140), used by MatrixRTC so that a call membership is removed
 * when a client disappears. Stored in the database; any instance may send a due
 * event, and deleting the row first guarantees it is sent exactly once.
 */
export class DelayedEventService {
  private hs: Homeserver;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly maxDelayMs: number;
  readonly maxPerUser: number;

  constructor(hs: Homeserver, options: DelayedEventsOptions = {}) {
    this.hs = hs;
    this.maxDelayMs = options.maxDelayMs ?? 24 * 3600_000;
    this.maxPerUser = options.maxPerUser ?? 100;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err) => this.hs.logger.warn("Delayed events failed", err)), 250);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async schedule(opts: {
    userId: string;
    deviceId: string;
    roomId: string;
    type: string;
    stateKey?: string;
    content: Record<string, any>;
    delayMs: number;
    txnId?: string;
  }): Promise<string> {
    if (!Number.isInteger(opts.delayMs) || opts.delayMs < 0) throw errors.invalidParam("Invalid delay");
    if (opts.delayMs > this.maxDelayMs) {
      throw new MatrixError(400, "M_MAX_DELAY_EXCEEDED", "Delay is too long", { [UNSTABLE.ORG.MATRIX.MSC4140.MAX_DELAY]: this.maxDelayMs });
    }
    const txnKey = opts.txnId ? `${opts.userId}|${opts.deviceId}|${opts.roomId}|${opts.txnId}` : null;
    if (txnKey) {
      const existing = await this.hs.db.findOne("delayed_events", [{ field: "txn_key", value: txnKey }]);
      if (existing) return existing.delay_id;
    }
    const pending = await this.hs.db.findMany("delayed_events", { where: [{ field: "user_id", value: opts.userId }] });
    if (pending.length >= this.maxPerUser) throw new MatrixError(400, "M_LIMIT_EXCEEDED", "Too many delayed events");
    await this.hs.rooms.requireJoined(opts.roomId, opts.userId);
    const delayId = `syd_${randomString(20)}`;
    const now = Date.now();
    await this.hs.db.create("delayed_events", {
      delay_id: delayId,
      user_id: opts.userId,
      device_id: opts.deviceId,
      room_id: opts.roomId,
      event_type: opts.type,
      state_key: opts.stateKey ?? null,
      content: opts.content,
      delay_ms: opts.delayMs,
      send_at: now + opts.delayMs,
      running_since: now,
      txn_key: txnKey,
    });
    return delayId;
  }

  async list(userId: string): Promise<Record<string, any>[]> {
    const rows = await this.hs.db.findMany("delayed_events", {
      where: [{ field: "user_id", value: userId }],
      sortBy: { field: "send_at", direction: "asc" },
    });
    return rows.map((r) => ({
      delay_id: r.delay_id,
      room_id: r.room_id,
      type: r.event_type,
      ...(r.state_key !== null ? { state_key: r.state_key } : {}),
      delay: r.delay_ms,
      running_since: r.running_since,
      content: r.content,
    }));
  }

  async update(userId: string, delayId: string, action: string): Promise<void> {
    if (!["cancel", "restart", "send"].includes(action)) throw errors.unrecognized("Unknown action");
    const where = [
      { field: "delay_id", value: delayId },
      { field: "user_id", value: userId },
    ];
    const row = await this.hs.db.findOne("delayed_events", where);
    if (!row) throw errors.notFound("Unknown delayed event");
    if (action === "cancel") {
      await this.hs.db.delete("delayed_events", where);
    } else if (action === "restart") {
      const now = Date.now();
      await this.hs.db.update("delayed_events", where, { send_at: now + row.delay_ms, running_since: now });
    } else {
      // Sent before the row goes (#100): a failure leaves it for a retry, and a repeat is deduplicated.
      await this.send(row);
      await this.hs.db.delete("delayed_events", where);
    }
  }

  /** Cancel pending delayed state events for a key overwritten by someone else (MSC4140). */
  async onStateEvent(roomId: string, type: string, stateKey: string, sender: string): Promise<void> {
    const rows = await this.hs.db.findMany("delayed_events", {
      where: [
        { field: "room_id", value: roomId },
        { field: "event_type", value: type },
        { field: "state_key", value: stateKey },
      ],
    });
    for (const r of rows) if (r.user_id !== sender) await this.hs.db.delete("delayed_events", [{ field: "delay_id", value: r.delay_id }]);
  }

  private async tick(): Promise<void> {
    const due = await this.hs.db.findMany("delayed_events", {
      where: [{ field: "send_at", operator: "lte", value: Date.now() }],
      sortBy: { field: "send_at", direction: "asc" },
      limit: 100,
    });
    for (const row of due) {
      // https://github.com/k18k/katrix/issues/100: the row was deleted before sending, so an event
      // whose send failed (or whose instance died) was lost. Whoever moves send_at on claims the row (safe across
      // instances) and sends; the row goes once the event is sent. Until then the new send_at is the retry time.
      // A repeat after a crash is deduplicated by the event's transaction ID.
      const claimed = await this.hs.db.update(
        "delayed_events",
        [
          { field: "delay_id", value: row.delay_id },
          { field: "send_at", value: row.send_at },
        ],
        { send_at: Date.now() + RETRY_MS },
      );
      if (!claimed) continue;
      try {
        await this.send(row);
        await this.hs.db.delete("delayed_events", [{ field: "delay_id", value: row.delay_id }]);
      } catch (err) {
        this.hs.logger.warn("Sending delayed event failed", row.delay_id, err);
        // Refused by the room (the user left, lost the power to send it...): retrying would not help.
        if (err instanceof MatrixError) await this.hs.db.delete("delayed_events", [{ field: "delay_id", value: row.delay_id }]);
      }
    }
  }

  private async send(row: Record<string, any>): Promise<void> {
    await this.hs.rooms.sendEvent(
      row.room_id,
      row.user_id,
      { type: row.event_type, content: row.content, ...(row.state_key !== null ? { state_key: row.state_key } : {}) },
      // A fixed transaction ID: sending the same delayed event again returns the first one.
      { txnId: `delayed:${row.delay_id}`, deviceId: DELAYED_DEVICE },
    );
  }
}
