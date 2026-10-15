import { randomString } from "../core/crypto.ts";
import type { Homeserver } from "../homeserver.ts";

const MAX_PDUS = 50;
const MAX_EDUS = 100;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 3600_000;
/** Destinations that only just went down are retried quickly; long outages back off further. */
const FAST_RETRY_CAP_MS = 10_000;
const FAST_RETRY_ATTEMPTS = 10;
const SWEEP_INTERVAL_MS = 30_000;

/**
 * Outbound transaction queue backed by the database (`federation_outbox`), so any
 * instance can enqueue and pending items survive restarts. Per destination, one
 * instance at a time (cluster lock) builds and sends transactions. Failed
 * destinations back off; ephemeral EDUs (typing, presence) are dropped on failure.
 */
export class TransactionSender {
  private hs: Homeserver;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(hs: Homeserver) {
    this.hs = hs;
  }

  /** Start background sweeping for destinations with pending items (e.g. after a restart). */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweep().catch(() => {}), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
    void this.sweep().catch(() => {});
  }

  private async sweep(): Promise<void> {
    const rows = await this.hs.db.findMany("federation_outbox", { sortBy: { field: "id", direction: "asc" }, limit: 1000 });
    for (const dest of new Set(rows.map((r) => r.destination))) this.schedule(dest, 0);
  }

  async sendPdu(destinations: Iterable<string>, pdu: Record<string, any>): Promise<void> {
    await this.enqueue(destinations, "pdu", pdu);
  }

  async sendEdu(destinations: Iterable<string>, eduType: string, content: Record<string, any>, durable = true): Promise<void> {
    await this.enqueue(destinations, durable ? "edu" : "edu-ephemeral", { edu_type: eduType, content });
  }

  private async enqueue(destinations: Iterable<string>, kind: string, payload: Record<string, any>): Promise<void> {
    for (const destination of new Set(destinations)) {
      if (destination === this.hs.serverName) continue;
      const id = await this.hs.cluster.nextId("federation_outbox");
      await this.hs.db.create("federation_outbox", { id, destination, kind, payload, created_ts: Date.now() });
      this.schedule(destination, 0);
    }
  }

  private schedule(destination: string, delayMs: number): void {
    if (this.hs.isClosed) return;
    const existing = this.timers.get(destination);
    if (existing && delayMs > 0) return;
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(destination);
      void this.flush(destination).catch((err) => this.hs.logger.debug("Federation flush failed", err));
    }, delayMs);
    timer.unref?.();
    this.timers.set(destination, timer);
  }

  private async flush(destination: string): Promise<void> {
    await this.hs.cluster.lock(`fedsend:${destination}`, async () => {
      const status = await this.hs.db.findOne("destination_status", [{ field: "destination", value: destination }]);
      if (status && status.retry_after_ts > Date.now()) {
        this.schedule(destination, status.retry_after_ts - Date.now());
        return;
      }
      try {
        for (;;) {
          const rows = await this.hs.db.findMany("federation_outbox", {
            where: [{ field: "destination", value: destination }],
            sortBy: { field: "id", direction: "asc" },
            limit: MAX_PDUS + MAX_EDUS,
          });
          if (!rows.length) break;
          const pdus = rows.filter((r) => r.kind === "pdu").slice(0, MAX_PDUS);
          const edus = rows.filter((r) => r.kind !== "pdu").slice(0, MAX_EDUS);
          const txnId = `${Date.now()}${randomString(6)}`;
          await this.hs.federation.client.request(destination, "PUT", `/_matrix/federation/v1/send/${txnId}`, {
            body: {
              origin: this.hs.serverName,
              origin_server_ts: Date.now(),
              pdus: pdus.map((p) => p.payload),
              edus: edus.map((e) => e.payload),
            },
            timeoutMs: 20_000,
          });
          const sent = [...pdus, ...edus].map((r) => r.id);
          await this.hs.db.delete("federation_outbox", [{ field: "id", operator: "in", value: sent }]);
        }
        if (status) await this.hs.db.delete("destination_status", [{ field: "destination", value: destination }]);
      } catch (err) {
        const failures = (status?.failures ?? 0) + 1;
        const cap = failures <= FAST_RETRY_ATTEMPTS ? FAST_RETRY_CAP_MS : MAX_RETRY_MS;
        const delay = Math.min(Math.round(MIN_RETRY_MS * 1.5 ** (failures - 1)), cap);
        await this.hs.db.upsert("destination_status", { destination, failures, retry_after_ts: Date.now() + delay });
        // Ephemeral items are not worth retrying.
        await this.hs.db.delete("federation_outbox", [{ field: "destination", value: destination }, { field: "kind", value: "edu-ephemeral" }]);
        this.hs.logger.debug("Federation send to", destination, "failed; retrying in", delay, "ms", err);
        this.schedule(destination, delay);
      }
    });
  }

  /** Retry a destination immediately (e.g. after it contacted us). */
  async wake(destination: string): Promise<void> {
    const status = await this.hs.db.findOne("destination_status", [{ field: "destination", value: destination }]);
    if (!status) return;
    await this.hs.db.delete("destination_status", [{ field: "destination", value: destination }]);
    this.schedule(destination, 0);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
