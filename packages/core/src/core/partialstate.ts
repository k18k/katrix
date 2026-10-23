import { CLUSTER_RESYNC } from "#core/cluster.ts";
import { EventEmitter } from "node:events";
import { eventIdOf, roomVersionFeatures, stateKey } from "#core/events.ts";
import type { Homeserver } from "#homeserver.ts";
import { M } from "#core/m.ts";

// MSC3902 "faster joins": a remote join with `omit_members=true` returns the room's state
// without most membership events. The room is usable right away (sending, receiving, lazy
// sync), while the full state is fetched in the background from the servers in the room.
// Until then, eager /sync omits the room, /members and /joined_members wait, and other
// servers cannot join or knock through us.

const RESYNC_CLAIM_MS = 10 * 60_000;

export class PartialStateService {
  private readonly hs: Homeserver;
  private readonly partial = new Map<string, boolean>();
  private readonly completed = new EventEmitter();
  private readonly running = new Set<string>();
  private readonly completedStreams = new Map<string, number | null>();
  private stopped = false;

  constructor(hs: Homeserver) {
    this.hs = hs;
    this.completed.setMaxListeners(0);
    hs.cluster.subscribe("partial-state", (msg: { roomId: string }) => {
      if (typeof msg?.roomId !== "string") return;
      this.partial.delete(msg.roomId);
      this.completedStreams.delete(msg.roomId);
      this.completed.emit(msg.roomId);
    });
    hs.cluster.subscribe(CLUSTER_RESYNC, () => {
      this.partial.clear();
      this.completedStreams.clear();
    });
  }

  async isPartial(roomId: string): Promise<boolean> {
    const cached = this.partial.get(roomId);
    if (cached !== undefined) return cached;
    const row = await this.hs.db.findOne("partial_state_rooms", [{ field: "room_id", value: roomId }]);
    const partial = !!row && row.completed_stream === null;
    if (this.partial.size > 10000) this.partial.clear();
    this.partial.set(roomId, partial);
    return partial;
  }

  /** Servers the joining server told us were in the room (used as destinations and resync sources). */
  async servers(roomId: string): Promise<string[]> {
    if (!(await this.isPartial(roomId))) return [];
    const row = await this.hs.db.findOne("partial_state_rooms", [{ field: "room_id", value: roomId }]);
    return Array.isArray(row?.servers) ? row!.servers : [];
  }

  /** Stream position at which the room got its full state (null if it never was partial). */
  async completedAt(roomId: string): Promise<number | null> {
    if (this.partial.get(roomId) === false && this.completedStreams.has(roomId)) return this.completedStreams.get(roomId)!;
    const row = await this.hs.db.findOne("partial_state_rooms", [{ field: "room_id", value: roomId }]);
    const at = row?.completed_stream ?? null;
    if (this.completedStreams.size > 10000) this.completedStreams.clear();
    this.completedStreams.set(roomId, at);
    return at;
  }

  /**
   * A device list update for a user we do not share a (known) room with: if they may be a member
   * of a partial-state room hosted by the sender, remember them for when the state is complete.
   */
  async notePendingDeviceUpdate(userId: string, origin: string): Promise<void> {
    const rows = (await this.hs.db.findMany("partial_state_rooms", {})).filter(
      (r) => r.completed_stream === null && (r.servers ?? []).includes(origin),
    );
    for (const row of rows) {
      const pending: string[] = Array.isArray(row.pending_device_users) ? row.pending_device_users : [];
      if (pending.includes(userId)) continue;
      await this.hs.db.update("partial_state_rooms", [{ field: "room_id", value: row.room_id }], {
        pending_device_users: [...pending, userId],
      });
    }
  }

  async markPartial(roomId: string, joinEventId: string, origin: string, servers: string[]): Promise<void> {
    await this.hs.db.upsert("partial_state_rooms", {
      room_id: roomId,
      join_event_id: joinEventId,
      origin,
      servers: [...new Set([origin, ...servers])],
      created_ts: Date.now(),
      completed_stream: null,
      pending_device_users: [],
    });
    this.partial.set(roomId, true);
    this.completedStreams.delete(roomId);
    void this.hs.cluster.publish("partial-state", { roomId }).catch(() => {});
    this.startResync(roomId);
  }

  /** Resolve once the room has its full state (or the signal aborts / the server closes). */
  async waitForFullState(roomId: string, signal?: AbortSignal): Promise<void> {
    if (!(await this.isPartial(roomId))) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearInterval(poll);
        this.completed.off(roomId, check);
        signal?.removeEventListener("abort", done);
        this.hs.off?.("close", done);
        resolve();
      };
      // State changes are announced on one channel for both directions: re-check before resolving.
      const check = () =>
        void this.isPartial(roomId)
          .then((p) => {
            if (!p) done();
          })
          .catch(() => {});
      this.completed.on(roomId, check);
      signal?.addEventListener("abort", done);
      this.hs.once?.("close", done);
      // Fallback for missed cluster messages.
      const poll = setInterval(() => {
        this.partial.delete(roomId);
        check();
      }, 5000);
      poll.unref?.();
    });
  }

  /** Resume resyncs of rooms left partial (e.g. by a restart). */
  async resume(): Promise<void> {
    const rows = (await this.hs.db.findMany("partial_state_rooms", {})).filter((r) => r.completed_stream === null);
    this.hs.logger.debug(
      "Resuming partial state resyncs",
      rows.map((r) => r.room_id),
    );
    for (const row of rows) this.startResync(row.room_id);
  }

  stop(): void {
    this.stopped = true;
  }

  startResync(roomId: string): void {
    if (this.running.has(roomId)) return;
    this.running.add(roomId);
    void this.resync(roomId)
      .catch((err) => this.hs.logger.warn("Partial state resync failed", roomId, err))
      .finally(() => this.running.delete(roomId));
  }

  private async resync(roomId: string): Promise<void> {
    const claim = `partial-resync:${roomId}`;
    // One instance resyncs a room at a time; a crashed instance's claim expires.
    if (!(await this.hs.cluster.setIfAbsent(claim, this.hs.instanceId, RESYNC_CLAIM_MS))) {
      this.hs.logger.debug("Partial state resync of", roomId, "is claimed elsewhere");
      return;
    }
    this.hs.logger.debug("Partial state resync of", roomId, "started");
    try {
      let delay = 1000;
      for (let attempt = 0; !this.stopped && !this.hs.isClosed; attempt++) {
        const row = await this.hs.db.findOne("partial_state_rooms", [{ field: "room_id", value: roomId }]);
        if (!row || row.completed_stream !== null) return;
        if (await this.tryResync(roomId, row)) return;
        if (this.stopped || this.hs.isClosed) return;
        // Nobody local is in the room any more: stop trying.
        if (!(await this.hs.rooms.serverIsJoined(roomId))) {
          await this.finish(roomId);
          return;
        }
        await new Promise((r) => setTimeout(r, delay).unref?.());
        delay = Math.min(delay * 2, 60_000);
        await this.hs.cluster.set(claim, this.hs.instanceId, RESYNC_CLAIM_MS);
      }
    } finally {
      await this.hs.cluster.delete(claim).catch(() => {});
    }
  }

  private async tryResync(roomId: string, row: Record<string, any>): Promise<boolean> {
    const version = await this.hs.rooms.roomVersion(roomId);
    const join = await this.hs.rooms.getEvent(row.join_event_id);
    if (!version || !join) {
      await this.finish(roomId);
      return true;
    }
    const prevIds = (join.pdu.prev_events ?? []).map(eventIdOf);
    const servers = [...new Set([row.origin, ...(row.servers ?? [])])].filter((s) => s && s !== this.hs.serverName);
    for (const server of servers) {
      if (this.stopped || this.hs.isClosed) return true;
      try {
        const fullBefore = await this.hs.federation.stateFromPrevs(server, roomId, version, prevIds, { remote: true });
        // Requests fail while shutting down: never complete (or give up on) a resync then.
        if (this.stopped || this.hs.isClosed) return true;
        if (!fullBefore[stateKey(M.ROOM.CREATE, "")] && !roomVersionFeatures(version).v12)
          throw new Error("Resynced state lacks the create event");
        // Servers we sent the room's traffic to while partial: the resident's list plus those in our partial state.
        const notified = new Set<string>([
          ...(row.servers ?? []),
          ...this.hs.federation.serversInRoom(await this.hs.rooms.currentState(roomId), false),
        ]);
        const missed = await this.hs.rooms.withLock(roomId, () =>
          this.hs.rooms.completePartialState(roomId, version, row.join_event_id, fullBefore, notified),
        );
        await this.finish(roomId);
        // Servers wrongly left out meanwhile get our members' device lists now.
        if (missed.length) {
          for (const userId of (await this.hs.rooms.joinedMembers(roomId)).filter((u) => this.hs.isLocalUser(u))) {
            await this.hs.federation.onDeviceListChange(userId, undefined, new Set(missed)).catch(() => {});
          }
        }
        return true;
      } catch (err) {
        this.hs.logger.debug("Partial state resync from", server, "failed", err);
      }
    }
    return false;
  }

  private async finish(roomId: string): Promise<void> {
    await this.hs.streams.write((stream) =>
      this.hs.db.update("partial_state_rooms", [{ field: "room_id", value: roomId }], { completed_stream: stream }),
    );
    this.partial.set(roomId, false);
    this.completedStreams.delete(roomId);
    this.completed.emit(roomId);
    void this.hs.cluster.publish("partial-state", { roomId }).catch(() => {});
    // Local members' eager syncs now include the room; tracked device lists may have changed.
    const members = await this.hs.rooms.joinedMembers(roomId);
    this.hs.notifier.notify(members.filter((u) => this.hs.isLocalUser(u)));
    const row = await this.hs.db.findOne("partial_state_rooms", [{ field: "room_id", value: roomId }]);
    const pending: string[] = Array.isArray(row?.pending_device_users) ? row!.pending_device_users : [];
    await this.hs.keys.onPartialStateComplete(roomId, pending).catch((err) => this.hs.logger.warn("Device list refresh failed", err));
  }
}
