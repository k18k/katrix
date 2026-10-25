import { isObject, isValidUserId, M, parseId } from "@katrix/shared";
import { CLUSTER_RESYNC } from "#core/cluster.ts";
import { errors, MatrixError } from "#core/errors.ts";
import {
  DEFAULT_ROOM_VERSION,
  SUPPORTED_ROOM_VERSIONS,
  eventIdOf,
  finalisePdu,
  redact,
  roomVersionFeatures,
  splitStateKey,
  stateKey,
  toClientEvent,
  type ClientEvent,
  type PDU,
} from "#core/events.ts";
import {
  authEventKeys,
  authStateFromAuthEvents,
  checkAuth,
  getState,
  membershipOf,
  powerLevels,
  userLevel,
  type StateMap,
} from "#core/authrules.ts";
import { resolveState, type StateIds } from "#core/stateres.ts";
import { generateRoomId } from "#core/ids.ts";
import type { Homeserver } from "#homeserver.ts";
import type { Row } from "#storage/types.ts";
import { copyRoomPushRules } from "#core/pushrules.ts";
import { inviteDecision } from "#core/invitefilter.ts";

const PARTIAL_REJECTION = "Partial state: ";

export interface StoredEvent {
  pdu: PDU;
  stream: number;
  snapshot: number;
  txnId: string | null;
  txnToken: string | null;
  /** Membership of the viewing user at this event (set by `filterVisible`). */
  viewerMembership?: string;
  /** The event's predecessors were not all available when it was persisted. */
  gap?: boolean;
}

export interface EventDraft {
  type: string;
  content: Record<string, any>;
  state_key?: string;
  redacts?: string;
}

interface Outlier {
  pdu: PDU;
  snapshot: number | null;
  rejected: string | null;
  softFailed: boolean;
}

interface StateBefore {
  ids: StateIds;
  /** Snapshot ID when the state equals an existing snapshot (single predecessor). */
  snapshot: number | null;
}

export interface PersistOptions {
  /** Event created by this server (already authorised). */
  local?: boolean;
  txnId?: string;
  deviceId?: string;
  /** Explicit state before the event (e.g. from a send_join response or /state_ids). */
  stateBefore?: StateIds;
  /** Historical event fetched by backfill: placed before existing timeline, no state changes. */
  backfill?: boolean;
  /** For v12 rooms when the create event is not part of the current state yet. */
  createEvent?: PDU;
  /** Result of checking the restricted-join authorising server's signature. */
  joinAuthorisedSignatureValid?: boolean;
  /** Do not send this local event to other servers (they already have it). */
  noFederate?: boolean;
  /** Explicit stream position (used by backfill to preserve ordering). */
  stream?: number;
  /** Some prev_events are unknown (filled from remote state instead). */
  gap?: boolean;
}

export interface PersistResult {
  eventId: string;
  status: "persisted" | "soft_failed" | "rejected";
  reason?: string;
}

/** Thrown when the state before an event cannot be computed because predecessors are unknown. */
export class MissingStateError extends Error {
  readonly eventIds: string[];
  constructor(eventIds: string[]) {
    super(`Missing state for ${eventIds.join(", ")}`);
    this.eventIds = eventIds;
  }
}

class LruCache<K, V> {
  private map = new Map<K, V>();
  private max: number;
  constructor(max: number) {
    this.max = max;
  }
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: K, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
  clear(): void {
    this.map.clear();
  }
  delete(k: K): void {
    this.map.delete(k);
  }
}

const MAX_EVENT_SIZE = 65536;
/** A full state snapshot is written after this many deltas. */
const SNAPSHOT_INTERVAL = 64;

/** Reject malformed power level content with 400 before it reaches the auth rules. */
export function validatePowerLevelContent(content: Record<string, any>, creators: Set<string>): void {
  const check = (v: unknown) => {
    if (typeof v === "number" && Math.abs(v) > Number.MAX_SAFE_INTEGER) throw errors.badJson("Power level out of range");
  };
  for (const v of Object.values(content)) {
    if (isObject(v)) Object.values(v).forEach(check);
    else check(v);
  }
  if (isObject(content.users)) {
    for (const u of Object.keys(content.users)) if (creators.has(u)) throw errors.badJson("Room creators cannot be given a power level");
  }
}

export const txnTokenOf = (userId: string, deviceId: string) => `${userId}|${deviceId}`;

export class RoomService {
  private hs: Homeserver;
  private eventCache = new LruCache<string, StoredEvent>(20000);
  private snapshotCache = new LruCache<number, Record<string, string>>(2000);
  private stateCache = new Map<string, StateMap>();
  private extremityCache = new Map<string, string[]>();
  private outlierCache = new LruCache<string, Outlier>(5000);
  private versions = new Map<string, string>();
  private snapshotDepths = new LruCache<number, number>(20000);
  private sharingCache = new Map<string, Set<string>>();

  private localClusterMarker: unknown;

  constructor(hs: Homeserver, singleInstance: boolean) {
    this.hs = hs;
    // With a single instance, caches can never go stale and need no invalidation on lock.
    this.localClusterMarker = singleInstance ? hs.cluster : null;
    hs.cluster.subscribe("invalidate", (msg: { from: string; rooms?: string[]; events?: string[]; sharing?: boolean }) => {
      if (msg?.from !== hs.instanceId) this.invalidateLocal(msg);
    });
    // Invalidations may have been missed (#92): forget everything that can change.
    hs.cluster.subscribe(CLUSTER_RESYNC, () => {
      for (const c of [this.stateCache, this.extremityCache, this.sharingCache, this.eventCache, this.outlierCache]) c.clear();
    });
  }

  /** Serialise writes per room (cluster-wide) so forward extremities stay consistent. */
  async withLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    return this.hs.cluster.lock(`room:${roomId}`, async () => {
      // Another instance may have written to the room since our caches were filled.
      if (this.hs.cluster !== this.localClusterMarker) this.invalidateLocal({ rooms: [roomId] });
      return fn();
    });
  }

  /** Drop cached data (for this instance only). */
  private invalidateLocal(msg: { rooms?: string[]; events?: string[]; sharing?: boolean }): void {
    for (const roomId of msg.rooms ?? []) {
      this.stateCache.delete(roomId);
      this.extremityCache.delete(roomId);
    }
    for (const id of msg.events ?? []) {
      this.eventCache.delete(id);
      this.outlierCache.delete(id);
    }
    if (msg.sharing) this.sharingCache.clear();
  }

  /** Tell other instances to drop cached data. */
  invalidate(msg: { rooms?: string[]; events?: string[]; sharing?: boolean }): void {
    void this.hs.cluster.publish("invalidate", { ...msg, from: this.hs.instanceId }).catch(() => {});
  }

  forgetEventCache(eventId: string): void {
    this.eventCache.delete(eventId);
  }

  /** Drop all cached data for a room (after it was purged). */
  forgetRoom(roomId: string): void {
    this.versions.delete(roomId);
    this.extremityCache.delete(roomId);
    this.stateCache.delete(roomId);
    this.sharingCache.clear();
  }

  async roomVersion(roomId: string): Promise<string | null> {
    const cached = this.versions.get(roomId);
    if (cached) return cached;
    const room = await this.hs.db.findOne("rooms", [{ field: "room_id", value: roomId }]);
    if (!room) return null;
    this.versions.set(roomId, room.room_version);
    return room.room_version;
  }

  async exists(roomId: string): Promise<boolean> {
    return (await this.roomVersion(roomId)) !== null;
  }

  rowToStored(row: Row): StoredEvent {
    // v12 create events carry no room_id in their PDU; add it back for local use.
    const pdu = row.json.room_id ? row.json : { ...row.json, room_id: row.room_id };
    return { pdu, stream: row.stream, snapshot: row.state_snapshot, txnId: row.txn_id, txnToken: row.txn_token, gap: !!row.gap };
  }

  async getEvent(eventId: string): Promise<StoredEvent | null> {
    const cached = this.eventCache.get(eventId);
    if (cached) return cached;
    const row = await this.hs.db.findOne("events", [{ field: "event_id", value: eventId }]);
    if (!row) return null;
    const stored = this.rowToStored(row);
    this.eventCache.set(eventId, stored);
    return stored;
  }

  async getEvents(eventIds: string[]): Promise<Map<string, StoredEvent>> {
    const out = new Map<string, StoredEvent>();
    const missing: string[] = [];
    for (const id of eventIds) {
      const c = this.eventCache.get(id);
      if (c) out.set(id, c);
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += 500) {
      const rows = await this.hs.db.findMany("events", {
        where: [{ field: "event_id", operator: "in", value: missing.slice(i, i + 500) }],
      });
      for (const row of rows) {
        const stored = this.rowToStored(row);
        this.eventCache.set(row.event_id, stored);
        out.set(row.event_id, stored);
      }
    }
    return out;
  }

  async snapshotIds(snapshotId: number): Promise<Record<string, string>> {
    if (snapshotId === 0) return {};
    const cached = this.snapshotCache.get(snapshotId);
    if (cached) return cached;
    const row = await this.hs.db.findOne("state_snapshots", [{ field: "id", value: snapshotId }]);
    const delta = (row?.state ?? {}) as Record<string, string>;
    const state = row?.prev ? { ...(await this.snapshotIds(row.prev)), ...delta } : delta;
    this.snapshotCache.set(snapshotId, state);
    this.snapshotDepths.set(snapshotId, row?.depth ?? 0);
    return state;
  }

  async stateAtSnapshot(snapshotId: number): Promise<StateMap> {
    // State events may be outliers (e.g. state received when joining over federation).
    return this.stateIdsToMap(await this.snapshotIds(snapshotId));
  }

  async currentState(roomId: string): Promise<StateMap> {
    const cached = this.stateCache.get(roomId);
    if (cached) return cached;
    const rows = await this.hs.db.findMany("current_state", { where: [{ field: "room_id", value: roomId }] });
    const events = await this.getPdus(rows.map((r) => r.event_id));
    const state: StateMap = new Map();
    for (const r of rows) {
      const ev = events.get(r.event_id);
      if (ev) state.set(stateKey(r.type, r.state_key), ev);
    }
    this.stateCache.set(roomId, state);
    return state;
  }

  async currentStateIds(roomId: string): Promise<StateIds> {
    const ids: StateIds = {};
    for (const [k, ev] of await this.currentState(roomId)) ids[k] = ev.event_id!;
    return ids;
  }

  /** Forward extremities: the latest events in the room DAG, used as prev_events of new events. */
  async extremities(roomId: string): Promise<string[]> {
    const cached = this.extremityCache.get(roomId);
    if (cached) return cached;
    const rows = await this.hs.db.findMany("forward_extremities", { where: [{ field: "room_id", value: roomId }] });
    const ids = rows.map((r) => r.event_id);
    this.extremityCache.set(roomId, ids);
    return ids;
  }

  // ---------------------------------------------------------------------------
  // Event lookup across the timeline and the outlier store
  // ---------------------------------------------------------------------------

  async getOutlier(eventId: string): Promise<Outlier | null> {
    const cached = this.outlierCache.get(eventId);
    if (cached) return cached;
    const row = await this.hs.db.findOne("outliers", [{ field: "event_id", value: eventId }]);
    if (!row) return null;
    const pdu = row.json.room_id ? row.json : { ...row.json, room_id: row.room_id };
    const outlier: Outlier = { pdu, snapshot: row.state_snapshot, rejected: row.rejected, softFailed: !!row.soft_failed };
    this.outlierCache.set(eventId, outlier);
    return outlier;
  }

  /** Any known PDU (timeline event or non-rejected outlier). */
  async getPdu(eventId: string): Promise<PDU | null> {
    const ev = await this.getEvent(eventId);
    if (ev) return ev.pdu;
    const o = await this.getOutlier(eventId);
    return o && !o.rejected ? o.pdu : null;
  }

  async getPdus(eventIds: string[]): Promise<Map<string, PDU>> {
    const out = new Map<string, PDU>();
    const timeline = await this.getEvents(eventIds);
    for (const [id, ev] of timeline) out.set(id, ev.pdu);
    for (const id of eventIds) {
      if (out.has(id)) continue;
      const o = await this.getOutlier(id);
      if (o && !o.rejected) out.set(id, o.pdu);
    }
    return out;
  }

  /** Whether we have seen this event at all (including rejected ones). */
  async knowsEvent(eventId: string): Promise<boolean> {
    return !!(await this.getEvent(eventId)) || !!(await this.getOutlier(eventId));
  }

  /** Snapshot ID of the state after an event, or null when the state is unknown. */
  async snapshotOf(eventId: string): Promise<number | null> {
    const ev = await this.getEvent(eventId);
    if (ev) return ev.snapshot;
    const o = await this.getOutlier(eventId);
    return o && !o.rejected && o.snapshot !== null ? o.snapshot : null;
  }

  async stateIdsToMap(ids: StateIds): Promise<StateMap> {
    const events = await this.getPdus(Object.values(ids));
    const state: StateMap = new Map();
    for (const [k, id] of Object.entries(ids)) {
      const ev = events.get(id);
      if (ev) state.set(k, ev);
    }
    return state;
  }

  async createEventOf(roomId: string): Promise<PDU | undefined> {
    return getState(await this.currentState(roomId), M.ROOM.CREATE);
  }

  /**
   * State before an event with the given prev_events: the snapshot of a single
   * predecessor, or the resolution of several. Throws MissingStateError when a
   * predecessor's state is unknown.
   */
  async stateBefore(roomId: string, version: string, prevIds: string[], createEvent?: PDU): Promise<StateBefore> {
    if (prevIds.length === 0) return { ids: {}, snapshot: 0 };
    const snapshots: number[] = [];
    const missing: string[] = [];
    // A rejected predecessor contributes the state before it (i.e. its own predecessors' state).
    const queue = [...prevIds];
    const visited = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (visited.has(id) || visited.size > 200) continue;
      visited.add(id);
      const snap = await this.snapshotOf(id);
      if (snap !== null) {
        snapshots.push(snap);
        continue;
      }
      const o = await this.getOutlier(id);
      if (o?.rejected) {
        queue.push(...(o.pdu.prev_events ?? []).map(eventIdOf));
        continue;
      }
      missing.push(id);
    }
    if (missing.length) throw new MissingStateError(missing);
    if (snapshots.length === 0) throw new MissingStateError(prevIds);
    const unique = [...new Set(snapshots)];
    if (unique.length === 1) return { ids: await this.snapshotIds(unique[0]), snapshot: unique[0] };
    const sets = await Promise.all(unique.map((s) => this.snapshotIds(s)));
    const ids = await resolveState(
      sets,
      version,
      (eids) => this.getPdus(eids),
      createEvent ?? (version && roomVersionFeatures(version).v12 ? await this.createEventOf(roomId) : undefined),
    );
    return { ids, snapshot: null };
  }

  /** Validate, authorise, sign and persist a new local event. Returns the event ID. */
  async sendEvent(
    roomId: string,
    sender: string,
    draft: EventDraft,
    opts: { txnId?: string; deviceId?: string; skipAuth?: boolean; ts?: number } = {},
  ): Promise<string> {
    return this.withLock(roomId, async () => {
      if (opts.txnId && opts.deviceId) {
        const token = txnTokenOf(sender, opts.deviceId);
        const existing = await this.hs.db.findOne("events", [
          { field: "txn_id", value: opts.txnId },
          { field: "txn_token", value: token },
        ]);
        if (existing && existing.room_id === roomId) return existing.event_id as string;
      }
      const version = await this.roomVersion(roomId);
      if (!version) throw errors.notFound("Unknown room");
      const pdu = await this.buildLocalEvent(roomId, version, sender, draft, opts.skipAuth, opts.ts);
      const result = await this.persistEvent(roomId, version, pdu, { local: true, txnId: opts.txnId, deviceId: opts.deviceId });
      return result.eventId;
    });
  }

  /** Build and sign (but do not persist) a local event on top of the current forward extremities. */
  async buildLocalEvent(roomId: string, version: string, sender: string, draft: EventDraft, skipAuth = false, ts?: number): Promise<PDU> {
    const features = roomVersionFeatures(version);
    const extremities = await this.extremities(roomId);
    const prevs = [...(await this.getPdus(extremities)).values()].sort((a, b) => b.depth - a.depth).slice(0, 10);
    const prevIds = prevs.map((p) => p.event_id!);
    const before =
      prevIds.length === extremities.length
        ? await this.currentState(roomId)
        : await this.stateIdsToMap((await this.stateBefore(roomId, version, prevIds)).ids);
    const authEvents = authEventKeys({ ...draft, sender }, version)
      .map((k) => before.get(k)?.event_id)
      .filter((x): x is string => !!x);
    const depth = Math.min(prevs.reduce((m, p) => Math.max(m, p.depth), 0) + 1, Number.MAX_SAFE_INTEGER);
    const pdu: PDU = {
      room_id: roomId,
      sender,
      type: draft.type,
      content: draft.content,
      origin_server_ts: ts ?? Date.now(),
      depth,
      prev_events: prevIds,
      auth_events: authEvents,
    };
    if (draft.state_key !== undefined) pdu.state_key = draft.state_key;
    if (draft.redacts !== undefined) {
      if (features.v11) pdu.content = { ...pdu.content, redacts: draft.redacts };
      else pdu.redacts = draft.redacts;
    }
    if (features.legacyEventIds) {
      pdu.prev_events = pdu.prev_events.map((id) => [id, {}]);
      pdu.auth_events = pdu.auth_events.map((id) => [id, {}]);
    }
    if (!skipAuth) {
      if (features.v12) before.set(stateKey(M.ROOM.CREATE, ""), (await this.createEventOf(roomId))!);
      checkAuth(pdu, before, version);
    }
    if (Buffer.byteLength(JSON.stringify(pdu)) > MAX_EVENT_SIZE) throw errors.tooLarge("Event too large");
    return finalisePdu(pdu, version, this.hs.serverName, this.hs.signingKey);
  }

  /**
   * Persist an event (local or remote). Remote events are checked against their auth
   * events, the state before them and the current state (soft failure).
   */
  async persistEvent(roomId: string, version: string, pdu: PDU, opts: PersistOptions = {}): Promise<PersistResult> {
    const features = roomVersionFeatures(version);
    const eventId = pdu.event_id!;
    if (await this.getEvent(eventId)) return { eventId, status: "persisted" };
    const createEvent = features.v12
      ? pdu.type === M.ROOM.CREATE
        ? undefined
        : (opts.createEvent ?? (await this.createEventOf(roomId)) ?? (await this.findCreateEvent(roomId)))
      : undefined;
    const prevIds = (pdu.prev_events ?? []).map(eventIdOf);

    if (!opts.local) {
      const reject = async (reason: string) => {
        await this.hs.db.upsert("outliers", {
          event_id: eventId,
          room_id: roomId,
          json: pdu,
          state_snapshot: null,
          rejected: reason,
          soft_failed: false,
        });
        this.outlierCache.delete(eventId);
        return { eventId, status: "rejected" as const, reason };
      };
      // Auth against the event's own auth events.
      try {
        const authPdus = await this.getPdus((pdu.auth_events ?? []).map(eventIdOf));
        if (authPdus.size !== (pdu.auth_events ?? []).length) return reject("Missing auth events");
        const authState = authStateFromAuthEvents(pdu, [...authPdus.values()], version, createEvent);
        checkAuth(pdu, authState, version, { joinAuthorisedSignatureValid: opts.joinAuthorisedSignatureValid });
      } catch (err) {
        return reject(`Auth events: ${(err as Error).message}`);
      }
    }
    let before: StateBefore;
    if (opts.stateBefore) before = { ids: opts.stateBefore, snapshot: null };
    else before = await this.stateBefore(roomId, version, prevIds, createEvent);
    const beforeMap = await this.stateIdsToMap(before.ids);
    if (createEvent) beforeMap.set(stateKey(M.ROOM.CREATE, ""), createEvent);

    // With partial state (MSC3902) the state before the event lacks most memberships: fill the
    // gaps from the event's own auth events, and skip the soft-fail check against current state.
    // The event is re-checked once the full state is known.
    const partial = !opts.local && !opts.backfill && (await this.hs.partialState.isPartial(roomId));
    if (partial) {
      // As Synapse does: state-resolve the (partial) state before the event with the event's
      // claimed auth events, so that what we do know (bans, kicks) still applies.
      const authPdus = await this.getPdus((pdu.auth_events ?? []).map(eventIdOf));
      const claimed: StateIds = {};
      for (const a of authPdus.values()) if (a.state_key !== undefined) claimed[stateKey(a.type, a.state_key)] = a.event_id!;
      const resolved = await resolveState([before.ids, claimed], version, (ids) => this.getPdus(ids), createEvent);
      for (const [key, ev] of await this.stateIdsToMap(resolved)) beforeMap.set(key, ev);
    }
    if (!opts.local) {
      const reject = async (reason: string) => {
        await this.hs.db.upsert("outliers", {
          event_id: eventId,
          room_id: roomId,
          json: pdu,
          state_snapshot: null,
          rejected: reason,
          soft_failed: false,
        });
        this.outlierCache.delete(eventId);
        return { eventId, status: "rejected" as const, reason };
      };
      // Auth against the state before the event.
      try {
        checkAuth(pdu, beforeMap, version, { joinAuthorisedSignatureValid: opts.joinAuthorisedSignatureValid });
      } catch (err) {
        // Rejections made against partial state (MSC3902) are revisited once the full state is known.
        return reject(`${partial ? PARTIAL_REJECTION : ""}State before: ${(err as Error).message}`);
      }
      // Soft failure: still part of the DAG, but not shown to clients.
      if (!opts.backfill && !opts.stateBefore && !partial) {
        const current = new Map(await this.currentState(roomId));
        if (createEvent) current.set(stateKey(M.ROOM.CREATE, ""), createEvent);
        const softFail = async () => {
          const ids = pdu.state_key !== undefined ? { ...before.ids, [stateKey(pdu.type, pdu.state_key)]: eventId } : before.ids;
          await this.hs.streams.write((snap) =>
            this.hs.transaction(async (db) => {
              await db.create("state_snapshots", { id: snap, room_id: roomId, prev: null, depth: 0, state: ids });
              await db.upsert("outliers", {
                event_id: eventId,
                room_id: roomId,
                json: pdu,
                state_snapshot: snap,
                rejected: null,
                soft_failed: true,
              });
            }),
          );
          this.outlierCache.delete(eventId);
          return { eventId, status: "soft_failed" as const };
        };
        try {
          checkAuth(pdu, current, version, { joinAuthorisedSignatureValid: opts.joinAuthorisedSignatureValid });
        } catch {
          return softFail();
        }
        // Events the room's policy server does not recommend are soft-failed too.
        if (!(await this.hs.policyServers.recommended(roomId, version, pdu))) return softFail();
      }
    }
    // Local events need the policy server's signature before they are stored and sent.
    if (opts.local) await this.hs.policyServers.signLocal(roomId, version, pdu);
    return this.store(roomId, version, pdu, before, beforeMap, features, opts);
  }

  /**
   * Finish a partial-state join (MSC3902): `fullBefore` is the complete state before our join
   * event. Recompute the state of the join and of every event received since, re-checking each
   * remote event against its now complete state (events wrongly accepted become rejected), then
   * rebuild the room's current state. Caller holds the room lock.
   */
  async completePartialState(
    roomId: string,
    version: string,
    joinEventId: string,
    fullBefore: StateIds,
    notified: Set<string>,
  ): Promise<string[]> {
    const features = roomVersionFeatures(version);
    const join = await this.getEvent(joinEventId);
    if (!join) return [];
    const createEvent = features.v12 ? await this.findCreateEvent(roomId) : undefined;
    const writeSnapshot = (ids: StateIds) =>
      this.hs.streams.write(async (id) => {
        await this.hs.db.create("state_snapshots", { id, room_id: roomId, prev: null, depth: 0, state: ids });
        this.snapshotCache.set(id, ids);
        this.snapshotDepths.set(id, 0);
        return id;
      });
    const setSnapshot = async (eventId: string, snapshot: number) => {
      await this.hs.db.update("events", [{ field: "event_id", value: eventId }], { state_snapshot: snapshot });
      this.eventCache.delete(eventId);
    };

    const joinKey = stateKey(M.ROOM.MEMBER, join.pdu.state_key!);
    await setSnapshot(joinEventId, await writeSnapshot({ ...fullBefore, [joinKey]: joinEventId }));

    // Everything after the join, plus events rejected against the partial state, in DAG order.
    const later = (
      await this.hs.db.findMany("events", {
        where: [
          { field: "room_id", value: roomId },
          { field: "stream", operator: "gt", value: join.stream },
        ],
        sortBy: { field: "stream", direction: "asc" },
      })
    ).map((row) => ({ pdu: this.rowToStored(row).pdu, stream: row.stream as number, rejected: false }));
    for (const row of await this.hs.db.findMany("outliers", { where: [{ field: "room_id", value: roomId }] })) {
      if (typeof row.rejected === "string" && row.rejected.startsWith(PARTIAL_REJECTION)) {
        later.push({
          pdu: row.json.room_id ? row.json : { ...row.json, room_id: roomId },
          stream: Number.MAX_SAFE_INTEGER,
          rejected: true,
        });
      }
    }
    later.sort((a, b) => (a.pdu.depth ?? 0) - (b.pdu.depth ?? 0) || a.stream - b.stream);
    const touched: string[] = [joinEventId];
    const reinstated: string[] = [];
    // Servers that were in the room at some point while our state was partial.
    const joinedServers = new Set<string>(this.hs.federation.serversInRoom(await this.stateIdsToMap(fullBefore), false));
    for (const item of later) {
      const pdu = item.pdu;
      let before: StateBefore;
      try {
        before = await this.stateBefore(roomId, version, (pdu.prev_events ?? []).map(eventIdOf), createEvent);
      } catch {
        continue; // Predecessors outside our knowledge (a gap): keep what we had.
      }
      const beforeMap = await this.stateIdsToMap(before.ids);
      if (createEvent) beforeMap.set(stateKey(M.ROOM.CREATE, ""), createEvent);
      let allowed = true;
      let reason = "";
      if (!this.hs.isLocalUser(pdu.sender)) {
        try {
          checkAuth(pdu, beforeMap, version, {});
        } catch (err) {
          allowed = false;
          reason = (err as Error).message;
        }
      }
      if (item.rejected) {
        if (!allowed) continue;
        // Rejected against the partial state, but the full state allows it.
        this.outlierCache.delete(pdu.event_id!);
        await this.store(roomId, version, pdu, before, beforeMap, features, { noFederate: true });
        touched.push(pdu.event_id!);
        reinstated.push(pdu.event_id!);
        continue;
      }
      if (!allowed) {
        // Accepted on partial state, but not allowed by the full state: reject it.
        await this.hs.transaction(async (db) => {
          await db.delete("events", [{ field: "event_id", value: pdu.event_id }]);
          await db.delete("relations", [{ field: "event_id", value: pdu.event_id }]);
          await db.upsert("outliers", {
            event_id: pdu.event_id,
            room_id: roomId,
            json: pdu,
            state_snapshot: null,
            rejected: `State before: ${reason}`,
            soft_failed: false,
          });
        });
        this.eventCache.delete(pdu.event_id!);
        this.outlierCache.delete(pdu.event_id!);
        touched.push(pdu.event_id!);
        continue;
      }
      if (pdu.type === M.ROOM.MEMBER && pdu.content?.membership === "join")
        joinedServers.add(pdu.state_key!.slice(pdu.state_key!.indexOf(":") + 1));
      const isState = pdu.state_key !== undefined;
      const snapshot =
        !isState && before.snapshot !== null && before.snapshot !== 0
          ? before.snapshot
          : await writeSnapshot(isState ? { ...before.ids, [stateKey(pdu.type, pdu.state_key!)]: pdu.event_id! } : before.ids);
      await setSnapshot(pdu.event_id!, snapshot);
      touched.push(pdu.event_id!);
    }
    // A reinstated event that already has successors is not a forward extremity.
    if (reinstated.length) {
      const referenced = new Set(later.filter((i) => !i.rejected).flatMap((i) => (i.pdu.prev_events ?? []).map(eventIdOf)));
      const stale = reinstated.filter((id) => referenced.has(id));
      if (stale.length) {
        for (const id of stale)
          await this.hs.db.delete("forward_extremities", [
            { field: "room_id", value: roomId },
            { field: "event_id", value: id },
          ]);
        this.extremityCache.delete(roomId);
      }
    }

    // Forward extremities may have pointed at events that are now rejected.
    const rejected = new Set<string>();
    for (const id of touched) if ((await this.getOutlier(id))?.rejected) rejected.add(id);
    let extremities = await this.extremities(roomId);
    if (extremities.some((id) => rejected.has(id))) {
      const replacement = new Set(extremities.filter((id) => !rejected.has(id)));
      for (const id of extremities.filter((x) => rejected.has(x))) {
        for (const prev of ((await this.getOutlier(id))?.pdu.prev_events ?? []).map(eventIdOf)) {
          if (await this.getEvent(prev)) replacement.add(prev);
        }
      }
      extremities = [...replacement];
      await this.hs.transaction(async (db) => {
        await db.delete("forward_extremities", [{ field: "room_id", value: roomId }]);
        for (const id of extremities) await db.upsert("forward_extremities", { room_id: roomId, event_id: id });
      });
      this.extremityCache.set(roomId, extremities);
    }

    // Rebuild current state from the extremities.
    const sets: StateIds[] = [];
    for (const ext of extremities) {
      const snap = await this.snapshotOf(ext);
      if (snap !== null) sets.push(await this.snapshotIds(snap));
    }
    if (!sets.length) return [];
    const newIds = sets.length === 1 ? sets[0] : await resolveState(sets, version, (ids) => this.getPdus(ids), createEvent);
    const oldIds = await this.currentStateIds(roomId);
    const pdus = await this.getPdus(Object.values(newIds));
    await this.hs.streams.write((stream) =>
      this.hs.transaction(async (db) => {
        for (const k of new Set([...Object.keys(oldIds), ...Object.keys(newIds)])) {
          if (oldIds[k] === newIds[k]) continue;
          const [type, sk] = splitStateKey(k);
          const where = [
            { field: "room_id", value: roomId },
            { field: "type", value: type },
            { field: "state_key", value: sk },
          ];
          if (!newIds[k]) {
            await db.delete("current_state", where);
            if (type === M.ROOM.MEMBER)
              await db.delete("memberships", [
                { field: "room_id", value: roomId },
                { field: "user_id", value: sk },
              ]);
            continue;
          }
          await db.upsert("current_state", { room_id: roomId, type, state_key: sk, event_id: newIds[k] });
          if (type === M.ROOM.MEMBER) {
            await db.upsert("memberships", {
              room_id: roomId,
              user_id: sk,
              membership: pdus.get(newIds[k])?.content?.membership ?? "leave",
              event_id: newIds[k],
              stream,
              forgotten: false,
            });
          }
        }
      }),
    );
    this.stateCache.delete(roomId);
    this.sharingCache.clear();
    this.invalidate({ rooms: [roomId], events: touched, sharing: true });
    // https://github.com/k18k/katrix/issues/50: local members whose membership
    // changed see it in their next sync; nothing else wakes them for it.
    const changedMembers = new Set<string>();
    for (const k of new Set([...Object.keys(oldIds), ...Object.keys(newIds)])) {
      const [type, userId] = splitStateKey(k);
      if (type === M.ROOM.MEMBER && oldIds[k] !== newIds[k] && this.hs.isLocalUser(userId)) changedMembers.add(userId);
    }
    if (changedMembers.size) this.hs.notifier.notify([...changedMembers, ...(await this.interestedUsers(roomId))]);
    // Remote users we wrongly believed to be in the room are no longer tracked.
    for (const k of Object.keys(oldIds)) {
      const [type, userId] = splitStateKey(k);
      if (type !== M.ROOM.MEMBER || this.hs.isLocalUser(userId) || oldIds[k] === newIds[k]) continue;
      if (!(await this.hs.keys.isTracked(userId))) await this.hs.keys.dropRemoteCache(userId);
    }
    for (const s of this.hs.federation.serversInRoom(await this.currentState(roomId), false)) joinedServers.add(s);
    // ... minus those we did send the room's traffic to: they missed nothing.
    return [...joinedServers].filter((s) => s !== this.hs.serverName && !notified.has(s));
  }

  /** The create event, also when the room's current state is not known yet (v12 joins). */
  private async findCreateEvent(roomId: string): Promise<PDU | undefined> {
    const id = `$${roomId.slice(1)}`;
    return (await this.getPdu(id)) ?? undefined;
  }

  private async store(
    roomId: string,
    version: string,
    pdu: PDU,
    before: StateBefore,
    beforeMap: StateMap,
    features: ReturnType<typeof roomVersionFeatures>,
    opts: PersistOptions,
  ): Promise<PersistResult> {
    const eventId = pdu.event_id!;
    const sender = pdu.sender;
    const backfill = !!opts.backfill;
    // The stream position is "in flight" until the event is committed, so no reader can skip past it.
    const lease = opts.stream !== undefined || backfill ? null : await this.hs.streams.allocate();
    const stream = opts.stream ?? (backfill ? await this.hs.streams.backfillId() : lease!.id);
    let wake: (() => Promise<void>) | null = null;
    try {
      const isState = pdu.state_key !== undefined;
      const key = isState ? stateKey(pdu.type, pdu.state_key!) : null;
      const prevState = key ? beforeMap.get(key) : undefined;
      const afterIds: StateIds = key ? { ...before.ids, [key]: eventId } : before.ids;

      // State snapshot: reuse the predecessor's for non-state events; otherwise store a delta or a full snapshot.
      let snapshot: number;
      let snapshotRow: Row | null = null;
      if (!isState && before.snapshot !== null && before.snapshot !== 0) {
        snapshot = before.snapshot;
      } else {
        snapshot = stream;
        const depth = before.snapshot ? (await this.snapshotDepth(before.snapshot)) + 1 : 0;
        snapshotRow =
          before.snapshot && key && depth < SNAPSHOT_INTERVAL
            ? { id: snapshot, room_id: roomId, prev: before.snapshot, depth, state: { [key]: eventId } }
            : { id: snapshot, room_id: roomId, prev: null, depth: 0, state: afterIds };
      }

      const unsigned: Record<string, any> = { ...pdu.unsigned };
      if (prevState) {
        unsigned.prev_content = prevState.content;
        unsigned.prev_sender = prevState.sender;
        unsigned.replaces_state = prevState.event_id;
      }
      if (pdu.type === M.ROOM.MEMBER && ["invite", "knock"].includes(pdu.content.membership) && opts.local) {
        unsigned[pdu.content.membership === "invite" ? "invite_room_state" : "knock_room_state"] = this.strippedState(beforeMap);
      }
      const stored: PDU = Object.keys(unsigned).length ? { ...pdu, unsigned } : pdu;
      const view: PDU = stored.room_id ? stored : { ...stored, room_id: roomId };
      const txnToken = opts.txnId && opts.deviceId ? txnTokenOf(sender, opts.deviceId) : null;
      const relation = pdu.content?.[M.RELATES_TO];
      const redactsId = features.v11 ? pdu.content?.redacts : pdu.redacts;
      const redaction =
        pdu.type === M.ROOM.REDACTION && typeof redactsId === "string" ? await this.prepareRedaction(redactsId, view, version) : null;

      // Forward extremities and the resulting current state.
      let newExtremities: string[] | null = null;
      let stateChanges: { key: string; eventId: string | null }[] = [];
      let newCurrentIds: StateIds | null = null;
      if (!backfill) {
        const prevIds = new Set((pdu.prev_events ?? []).map(eventIdOf));
        const old = await this.extremities(roomId);
        newExtremities = [...old.filter((id) => !prevIds.has(id)), eventId];
        const oldCurrent = await this.currentStateIds(roomId);
        if (newExtremities.length === 1) {
          newCurrentIds = afterIds;
        } else {
          const sets: StateIds[] = [afterIds];
          for (const ext of newExtremities) {
            if (ext === eventId) continue;
            const snap = await this.snapshotOf(ext);
            if (snap !== null) sets.push(await this.snapshotIds(snap));
          }
          const createEvent = features.v12
            ? (beforeMap.get(stateKey(M.ROOM.CREATE, "")) ?? (pdu.type === M.ROOM.CREATE ? pdu : undefined))
            : undefined;
          newCurrentIds = await resolveState(
            sets,
            version,
            async (ids) => {
              const found = await this.getPdus(ids);
              if (ids.includes(eventId)) found.set(eventId, view);
              return found;
            },
            createEvent,
          );
        }
        for (const k of new Set([...Object.keys(oldCurrent), ...Object.keys(newCurrentIds)])) {
          if (oldCurrent[k] !== newCurrentIds[k]) stateChanges.push({ key: k, eventId: newCurrentIds[k] ?? null });
        }
      }
      const changedPdus = await this.getPdus(stateChanges.map((c) => c.eventId).filter((x): x is string => !!x && x !== eventId));
      changedPdus.set(eventId, view);

      await this.hs.transaction(async (db) => {
        if (snapshotRow) await db.create("state_snapshots", snapshotRow);
        await db.create("events", {
          event_id: eventId,
          room_id: roomId,
          stream,
          depth: pdu.depth,
          type: pdu.type,
          state_key: pdu.state_key ?? null,
          sender,
          json: stored,
          state_snapshot: snapshot,
          txn_id: txnToken ? opts.txnId : null,
          txn_token: txnToken,
          redacted_by: null,
          gap: !!opts.gap,
        });
        // An outlier that is now part of the timeline.
        await db.delete("outliers", [{ field: "event_id", value: eventId }]);
        const edge = pdu.content?.[M.RELATIONSHIP];
        if (isObject(edge) && typeof edge.event_id === "string" && typeof edge.rel_type === "string") {
          await db.upsert("event_edges", {
            event_id: eventId,
            room_id: roomId,
            parent_id: edge.event_id,
            rel_type: edge.rel_type,
            ts: pdu.origin_server_ts ?? 0,
            depth: pdu.depth ?? 0,
          });
        }
        if (isObject(relation) && typeof relation.event_id === "string" && typeof relation.rel_type === "string") {
          await db.upsert("relations", {
            event_id: eventId,
            room_id: roomId,
            parent_id: relation.event_id,
            rel_type: relation.rel_type,
            type: pdu.type,
            sender,
            stream,
          });
        }
        if (newExtremities) {
          for (const prev of (pdu.prev_events ?? []).map(eventIdOf)) {
            await db.delete("forward_extremities", [
              { field: "room_id", value: roomId },
              { field: "event_id", value: prev },
            ]);
          }
          await db.upsert("forward_extremities", { room_id: roomId, event_id: eventId });
        }
        for (const change of stateChanges) {
          const [type, sk] = splitStateKey(change.key);
          const where = [
            { field: "room_id", value: roomId },
            { field: "type", value: type },
            { field: "state_key", value: sk },
          ];
          if (change.eventId === null) {
            await db.delete("current_state", where);
            if (type === M.ROOM.MEMBER)
              await db.delete("memberships", [
                { field: "room_id", value: roomId },
                { field: "user_id", value: sk },
              ]);
            continue;
          }
          await db.upsert("current_state", { room_id: roomId, type, state_key: sk, event_id: change.eventId });
          if (type === M.ROOM.MEMBER) {
            const member = changedPdus.get(change.eventId);
            await db.upsert("memberships", {
              room_id: roomId,
              user_id: sk,
              membership: member?.content?.membership ?? "leave",
              event_id: change.eventId,
              stream,
              forgotten: false,
            });
          }
        }
        if (redaction) {
          await db.update("events", [{ field: "event_id", value: redaction.targetId }], { json: redaction.redacted, redacted_by: eventId });
          await db.delete("relations", [{ field: "event_id", value: redaction.targetId }]);
        }
      });

      // Committed: update caches.
      this.outlierCache.delete(eventId);
      if (snapshotRow) {
        this.snapshotCache.set(snapshot, afterIds);
        this.snapshotDepths.set(snapshot, snapshotRow.depth);
      }
      this.eventCache.set(eventId, { pdu: view, stream, snapshot, txnId: txnToken ? opts.txnId! : null, txnToken, gap: !!opts.gap });
      if (newExtremities) this.extremityCache.set(roomId, newExtremities);
      let newState = await this.currentState(roomId);
      if (stateChanges.length) {
        newState = new Map(newState);
        for (const c of stateChanges) {
          if (c.eventId === null) newState.delete(c.key);
          else newState.set(c.key, changedPdus.get(c.eventId)!);
        }
        this.stateCache.set(roomId, newState);
      }
      if (redaction) this.commitRedaction(redaction, roomId);
      this.invalidate({
        rooms: newExtremities ? [roomId] : [],
        events: [eventId, ...(redaction ? [redaction.targetId] : [])],
        sharing: stateChanges.some((c) => c.key.startsWith("m.room.member\u0000")),
      });

      const memberChanges = stateChanges.filter((c) => c.key.startsWith("m.room.member\u0000"));
      if (memberChanges.length) {
        this.sharingCache.clear();
        for (const c of memberChanges) {
          const userId = splitStateKey(c.key)[1];
          if (this.hs.isLocalUser(userId) || c.eventId === eventId) await this.hs.keys.markDeviceListChanged(userId, false);
          // A remote user's cached device list is only trusted while continuously tracked.
          if (!this.hs.isLocalUser(userId)) {
            const m = changedPdus.get(c.eventId ?? "")?.content?.membership;
            if (m === "join" && prevState?.content?.membership !== "join" && c.eventId === eventId)
              await this.hs.keys.dropRemoteCache(userId);
            else if (m !== "join" && !(await this.hs.keys.isTracked(userId))) await this.hs.keys.dropRemoteCache(userId);
          }
          // A local user joining a room shares their devices with the servers in it.
          const joinedNow = changedPdus.get(c.eventId ?? "")?.content?.membership === "join";
          const wasJoined = c.eventId === eventId && prevState?.content?.membership === "join";
          if (this.hs.isLocalUser(userId) && joinedNow && !wasJoined) {
            // Only the servers of this room, as far as its (possibly partial) state tells.
            const to = this.hs.federation.serversInRoom(newState);
            if (to.size) void this.hs.federation.onDeviceListChange(userId, undefined, to).catch(() => {});
          }
        }
      }

      if (!backfill) {
        const storedEvent = this.eventCache.get(eventId)!;
        try {
          await this.hs.push.onEvent(storedEvent, newState, version);
        } catch (err) {
          this.hs.logger.error("Push processing failed for", eventId, err);
        }
        if (opts.local && !opts.noFederate) this.hs.federation.onLocalEvent(view, newState);
        if (this.hs.appservices.registrations.length)
          await this.hs.appservices.onEvent(view, newState).catch((err) => this.hs.logger.warn("Appservice push failed", err));
        if (isState) await this.hs.delayedEvents.onStateEvent(roomId, pdu.type, pdu.state_key!, sender).catch(() => {});
        // Guests leave rooms that stop allowing them (#87). In the background: it sends events, under the room lock.
        if (key === stateKey(M.ROOM.GUEST_ACCESS, "") && pdu.content?.guest_access !== "can_join")
          void this.removeGuests(roomId).catch((err) => this.hs.logger.warn("Could not remove guests from", roomId, err));
        wake = async () => {
          this.hs.notifier.notify(await this.interestedUsers(roomId), backfill ? undefined : stream);
          this.hs.emit("event", toClientEvent(view));
          // Admin room commands run in the background so the sender's request is not delayed.
          if (this.hs.adminRoom) void this.hs.adminRoom.onEvent(view).catch((err) => this.hs.logger.error("Admin command failed", err));
        };
      }
    } finally {
      await lease?.done();
    }
    await wake?.();
    return { eventId, status: "persisted" };
  }

  private async snapshotDepth(id: number): Promise<number> {
    const cached = this.snapshotDepths.get(id);
    if (cached !== undefined) return cached;
    const row = await this.hs.db.findOne("state_snapshots", [{ field: "id", value: id }]);
    const depth = row?.depth ?? 0;
    this.snapshotDepths.set(id, depth);
    return depth;
  }

  async membership(roomId: string, userId: string): Promise<string> {
    return membershipOf(await this.currentState(roomId), userId);
  }

  async requireJoined(roomId: string, userId: string): Promise<StateMap> {
    if (!(await this.exists(roomId))) throw errors.forbidden("You are not in this room");
    const state = await this.currentState(roomId);
    if (membershipOf(state, userId) !== "join") throw errors.forbidden("You are not joined to this room");
    return state;
  }

  async joinedMembers(roomId: string): Promise<string[]> {
    const rows = await this.hs.db.findMany("memberships", {
      where: [
        { field: "room_id", value: roomId },
        { field: "membership", value: "join" },
      ],
    });
    return rows.map((r) => r.user_id);
  }

  /** Users that should be woken up for events in this room. */
  private async interestedUsers(roomId: string): Promise<string[]> {
    const rows = await this.hs.db.findMany("memberships", { where: [{ field: "room_id", value: roomId }] });
    return rows.map((r) => r.user_id);
  }

  async roomsForUser(userId: string, membership = "join"): Promise<string[]> {
    const rows = await this.hs.db.findMany("memberships", {
      where: [
        { field: "user_id", value: userId },
        { field: "membership", value: membership },
      ],
    });
    return rows.map((r) => r.room_id);
  }

  /**
   * Membership changes after `since` in the rooms where `userId` has a membership (in any state),
   * given the user's own membership rows if the caller has them.
   *
   * https://github.com/k18k/katrix/issues/31: /sync and device-list tracking
   * read every membership change on the server since their token and kept those in the user's
   * rooms; while many users joined, each sync parsed thousands of rows. This reads those rooms only.
   */
  async membershipChangesSince(userId: string, since: number, mine?: Row[]): Promise<Row[]> {
    const own = mine ?? (await this.hs.db.findMany("memberships", { where: [{ field: "user_id", value: userId }] }));
    const rooms = [...new Set(own.map((m) => m.room_id as string))];
    if (rooms.length === 0) return [];
    return this.hs.db.findMany("memberships", {
      where: [
        { field: "room_id", operator: "in", value: rooms },
        { field: "stream", operator: "gt", value: since },
      ],
    });
  }

  /** All users sharing at least one joined room with `userId` (including themselves). */
  async usersSharingRooms(userId: string): Promise<Set<string>> {
    const cached = this.sharingCache.get(userId);
    if (cached) return new Set(cached);
    const out = new Set<string>([userId]);
    for (const roomId of await this.roomsForUser(userId)) {
      for (const u of await this.joinedMembers(roomId)) out.add(u);
    }
    if (this.sharingCache.size > 10000) this.sharingCache.clear();
    this.sharingCache.set(userId, out);
    return new Set(out);
  }

  private async prepareRedaction(
    targetId: string,
    redaction: PDU,
    version: string,
  ): Promise<{ targetId: string; target: StoredEvent; redacted: PDU } | null> {
    const target = await this.getEvent(targetId);
    if (!target || target.pdu.room_id !== redaction.room_id) return null;
    const state = await this.currentState(redaction.room_id);
    const pl = powerLevels(state, version);
    // Senders may always redact their own events; otherwise the redact level is needed.
    if (target.pdu.sender !== redaction.sender && userLevel(pl, redaction.sender) < pl.redact) return null;
    const redacted = redact(target.pdu as Record<string, any>, version) as PDU;
    redacted.unsigned = { redacted_because: toClientEvent(redaction) };
    if (target.pdu.unsigned?.prev_content) redacted.unsigned.prev_content = target.pdu.unsigned.prev_content;
    return { targetId, target, redacted };
  }

  private commitRedaction(r: { targetId: string; target: StoredEvent; redacted: PDU }, roomId: string): void {
    const view = r.redacted.room_id ? r.redacted : { ...r.redacted, room_id: roomId };
    this.eventCache.set(r.targetId, { ...r.target, pdu: view });
    if (r.target.pdu.state_key !== undefined) {
      const key = stateKey(r.target.pdu.type, r.target.pdu.state_key);
      const cur = this.stateCache.get(roomId);
      if (cur?.get(key)?.event_id === r.targetId) cur.set(key, view);
    }
  }

  /** Check whether a redaction would be permitted, before sending it. */
  async checkRedactionAllowed(roomId: string, sender: string, targetId: string): Promise<void> {
    const version = (await this.roomVersion(roomId))!;
    const state = await this.currentState(roomId);
    const pl = powerLevels(state, version);
    const target = await this.getEvent(targetId);
    if (target && target.pdu.room_id === roomId && target.pdu.sender !== sender && userLevel(pl, sender) < pl.redact) {
      throw errors.forbidden("Insufficient power level to redact this event");
    }
  }

  /**
   * Room state shared with invitees and knockers (MSC4311): full PDUs in federation
   * format, including the create event. Clients receive stripped versions.
   */
  strippedState(state: StateMap): Record<string, any>[] {
    const types = [M.ROOM.CREATE, M.ROOM.JOIN_RULES, M.ROOM.NAME, M.ROOM.AVATAR, M.ROOM.CANONICAL_ALIAS, M.ROOM.ENCRYPTION, M.ROOM.TOPIC];
    const create = getState(state, M.ROOM.CREATE);
    const version = typeof create?.content?.room_version === "string" ? create.content.room_version : "1";
    const f = roomVersionFeatures(version);
    const out: Record<string, any>[] = [];
    for (const t of types) {
      const ev = getState(state, t);
      if (!ev) continue;
      const { unsigned, ...full } = ev as PDU & Record<string, any>;
      const wire: Record<string, any> = { ...full };
      if (!f.legacyEventIds) delete wire.event_id;
      if (f.v12 && t === M.ROOM.CREATE) delete wire.room_id;
      out.push(wire);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  /** Filter events down to those `userId` may see according to history visibility. */
  async filterVisible(userId: string | null, roomId: string, events: StoredEvent[]): Promise<StoredEvent[]> {
    if (events.length === 0) return events;
    let memberHistory: { stream: number; membership: string }[] | null = null;
    const loadHistory = async () => {
      if (memberHistory) return memberHistory;
      if (!userId) return (memberHistory = []);
      const rows = await this.hs.db.findMany("events", {
        where: [
          { field: "room_id", value: roomId },
          { field: "type", value: M.ROOM.MEMBER },
          { field: "state_key", value: userId },
        ],
      });
      memberHistory = rows.map((r) => ({ stream: r.stream, membership: r.json.content?.membership }));
      return memberHistory;
    };
    const out: StoredEvent[] = [];
    for (const raw of events) {
      const ids = await this.snapshotIds(raw.snapshot);
      let membership = "leave";
      if (userId) {
        const memId = ids[stateKey(M.ROOM.MEMBER, userId)];
        membership = memId ? ((await this.getEvent(memId))?.pdu.content?.membership ?? "leave") : "leave";
      }
      const ev: StoredEvent = userId ? { ...raw, viewerMembership: membership } : raw;
      if (userId && ev.pdu.type === M.ROOM.MEMBER && ev.pdu.state_key === userId) {
        out.push(ev);
        continue;
      }
      const hvId = ids[stateKey(M.ROOM.HISTORY_VISIBILITY, "")];
      const hv = hvId ? ((await this.getEvent(hvId))?.pdu.content?.history_visibility ?? "shared") : "shared";
      if (hv === "world_readable") {
        out.push(ev);
        continue;
      }
      if (!userId) continue;
      if (membership === "join") {
        out.push(ev);
        continue;
      }
      if (hv === "invited" && membership === "invite") {
        out.push(ev);
        continue;
      }
      if (hv === "shared") {
        const history = await loadHistory();
        // Joined after the event, or joined now: the latter also covers events that arrive late from
        // a fork predating our join (their stream position is newer than the join).
        const latest = history.reduce<{ stream: number; membership: string } | null>((a, h) => (!a || h.stream > a.stream ? h : a), null);
        if (latest?.membership === "join" || history.some((h) => h.stream >= ev.stream && h.membership === "join")) {
          out.push(ev);
          continue;
        }
      }
    }
    return out;
  }

  /** Whether the user may view the room's current state / history at all (`world_readable` or member). */
  async canPeek(roomId: string, userId: string): Promise<{ joined: boolean; worldReadable: boolean; membership: string }> {
    const state = await this.currentState(roomId);
    const membership = membershipOf(state, userId);
    const hv = getState(state, M.ROOM.HISTORY_VISIBILITY)?.content?.history_visibility ?? "shared";
    return { joined: membership === "join", worldReadable: hv === "world_readable", membership };
  }

  /** The state snapshot visible to a user who is no longer joined (state at their leave). */
  async membershipEvent(roomId: string, userId: string): Promise<StoredEvent | null> {
    const state = await this.currentState(roomId);
    const ev = getState(state, M.ROOM.MEMBER, userId);
    return ev?.event_id ? this.getEvent(ev.event_id) : null;
  }

  formatEvent(ev: StoredEvent, viewer?: { userId: string; deviceId: string } | null, opts: { includeRoomId?: boolean } = {}): ClientEvent {
    const client = toClientEvent(ev.pdu, opts);
    if (viewer && ev.txnToken && ev.txnToken === txnTokenOf(viewer.userId, viewer.deviceId)) {
      client.unsigned = { ...client.unsigned, transaction_id: ev.txnId };
    }
    if (ev.viewerMembership) client.unsigned = { ...client.unsigned, membership: ev.viewerMembership };
    return client;
  }

  stateToList(state: StateMap): PDU[] {
    return [...state.values()];
  }

  // ---------------------------------------------------------------------------
  // Room lifecycle
  // ---------------------------------------------------------------------------

  async createRoom(sender: string, body: Record<string, any>): Promise<{ room_id: string; room_alias?: string }> {
    if (body.room_version !== undefined && typeof body.room_version !== "string") throw errors.badJson("room_version must be a string");
    const version = body.room_version ?? this.hs.config.defaultRoomVersion;
    if (!SUPPORTED_ROOM_VERSIONS.includes(version)) throw errors.unsupportedRoomVersion();
    const features = roomVersionFeatures(version);
    const visibility = body.visibility === "public" ? "public" : "private";
    const preset: string = body.preset ?? (visibility === "public" ? "public_chat" : "private_chat");
    if (!["public_chat", "private_chat", "trusted_private_chat"].includes(preset)) throw errors.invalidParam("Unknown preset");
    if (body.creation_content !== undefined && !isObject(body.creation_content)) throw errors.badJson("creation_content must be an object");
    if (body.initial_state !== undefined && !Array.isArray(body.initial_state)) throw errors.badJson("initial_state must be an array");
    if (body.invite !== undefined && (!Array.isArray(body.invite) || !body.invite.every(isValidUserId)))
      throw errors.invalidParam("invite must be a list of user IDs");
    if (body.name !== undefined && typeof body.name !== "string") throw errors.badJson("name must be a string");
    if (body.topic !== undefined && typeof body.topic !== "string") throw errors.badJson("topic must be a string");
    if (Array.isArray(body.invite_3pid) && body.invite_3pid.length > 0) throw errors.threepidDenied();

    let alias: string | undefined;
    if (body.room_alias_name !== undefined) {
      if (typeof body.room_alias_name !== "string" || /[:\s#]/.test(body.room_alias_name) || body.room_alias_name.length === 0) {
        throw errors.invalidParam("Invalid room_alias_name");
      }
      alias = `#${body.room_alias_name}:${this.hs.serverName}`;
      if (await this.hs.db.findOne("room_aliases", [{ field: "alias", value: alias }])) throw errors.roomInUse();
    }

    const createContent: Record<string, any> = { ...body.creation_content, room_version: version };
    if (!features.v11) createContent.creator = sender;
    else delete createContent.creator;
    const creators = new Set<string>();
    if (features.v12) {
      const extra = createContent.additional_creators;
      if (extra !== undefined && (!Array.isArray(extra) || !extra.every(isValidUserId))) {
        throw errors.badJson("additional_creators must be a list of user IDs");
      }
      const additional = new Set<string>(extra ?? []);
      // trusted_private_chat makes invitees creators instead of giving them PL 100.
      if (preset === "trusted_private_chat") for (const u of body.invite ?? []) additional.add(u);
      additional.delete(sender);
      if (additional.size) createContent.additional_creators = [...additional];
      else delete createContent.additional_creators;
      creators.add(sender);
      for (const u of additional) creators.add(u);
    } else {
      delete createContent.additional_creators;
    }

    let roomId: string;
    let prebuiltCreate: PDU | undefined;
    if (features.v12) {
      // The room ID is derived from the create event, which therefore has no room_id.
      prebuiltCreate = finalisePdu(
        {
          sender,
          type: M.ROOM.CREATE,
          state_key: "",
          content: createContent,
          origin_server_ts: Date.now(),
          depth: 1,
          prev_events: [],
          auth_events: [],
        } as unknown as PDU,
        version,
        this.hs.serverName,
        this.hs.signingKey,
      );
      roomId = `!${prebuiltCreate.event_id!.slice(1)}`;
    } else {
      roomId = generateRoomId(this.hs.serverName);
    }
    await this.hs.db.create("rooms", {
      room_id: roomId,
      room_version: version,
      creator: sender,
      is_public: visibility === "public",
      created_ts: Date.now(),
    });
    this.versions.set(roomId, version);

    const send = (draft: EventDraft) => this.sendEvent(roomId, sender, draft);
    if (prebuiltCreate) {
      const pdu = prebuiltCreate;
      await this.withLock(roomId, () => this.persistEvent(roomId, version, pdu, { local: true }));
    } else {
      await send({ type: M.ROOM.CREATE, state_key: "", content: createContent });
    }
    const profile = await this.hs.profile(sender);
    await send({ type: M.ROOM.MEMBER, state_key: sender, content: { membership: "join", ...profile } });

    const pl: Record<string, any> = {
      users: features.v12 ? {} : { [sender]: 100 },
      users_default: 0,
      events: {
        [M.ROOM.NAME]: 50,
        [M.ROOM.POWER_LEVELS]: 100,
        [M.ROOM.HISTORY_VISIBILITY]: 100,
        [M.ROOM.CANONICAL_ALIAS]: 50,
        [M.ROOM.AVATAR]: 50,
        [M.ROOM.TOMBSTONE]: features.v12 ? 150 : 100,
        [M.ROOM.SERVER_ACL]: 100,
        [M.ROOM.ENCRYPTION]: 100,
      },
      // Like Synapse: in public rooms only moderators invite; private presets let everyone invite.
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: preset === "public_chat" ? 50 : 0,
      notifications: { room: 50 },
    };
    if (preset === "trusted_private_chat" && !features.v12) for (const u of body.invite ?? []) pl.users[u] = 100;
    const override = body.power_level_content_override;
    if (override !== undefined && !isObject(override)) throw errors.badJson("power_level_content_override must be an object");
    const initialState: any[] = body.initial_state ?? [];
    const initialPl = initialState.find((e) => e?.type === M.ROOM.POWER_LEVELS && (e.state_key ?? "") === "");
    const predecessor = createContent.predecessor?.room_id;
    if (typeof predecessor === "string") await copyRoomPushRules(this.hs, sender, predecessor, roomId);
    const plContent = { ...pl, ...override, ...initialPl?.content };
    validatePowerLevelContent(plContent, creators);
    await send({ type: M.ROOM.POWER_LEVELS, state_key: "", content: plContent });

    if (alias) {
      await this.hs.db.create("room_aliases", { alias, room_id: roomId, creator: sender });
      await send({ type: M.ROOM.CANONICAL_ALIAS, state_key: "", content: { alias } });
    }

    const presetState: [string, Record<string, any>][] = [
      [M.ROOM.JOIN_RULES, { join_rule: preset === "public_chat" ? "public" : "invite" }],
      [M.ROOM.HISTORY_VISIBILITY, { history_visibility: "shared" }],
    ];
    if (preset !== "public_chat") presetState.push([M.ROOM.GUEST_ACCESS, { guest_access: "can_join" }]);
    const initialKeys = new Set(initialState.map((e) => stateKey(e?.type, e?.state_key ?? "")));
    for (const [type, content] of presetState) {
      if (!initialKeys.has(stateKey(type, ""))) await send({ type, state_key: "", content });
    }
    for (const ev of initialState) {
      if (!isObject(ev) || typeof ev.type !== "string" || !isObject(ev.content)) throw errors.badJson("Invalid initial_state event");
      if (ev.type === M.ROOM.POWER_LEVELS || ev.type === M.ROOM.CREATE || ev.type === M.ROOM.MEMBER) continue;
      await send({ type: ev.type, state_key: ev.state_key ?? "", content: ev.content });
    }
    if (body.name !== undefined) await send({ type: M.ROOM.NAME, state_key: "", content: { name: body.name } });
    if (body.topic !== undefined) {
      await send({
        type: M.ROOM.TOPIC,
        state_key: "",
        content: { topic: body.topic, [M.TOPIC]: { [M.TEXT]: [{ mimetype: "text/plain", body: body.topic }] } },
      });
    }
    for (const invitee of body.invite ?? []) {
      // A user who blocks invites is left out; the room is still created (spec, invite blocking; #88).
      await this.invite(roomId, sender, invitee, { isDirect: !!body.is_direct }).catch((err) => {
        if (!(err instanceof MatrixError && err.errcode === "M_INVITE_BLOCKED")) throw err;
      });
    }
    return alias ? { room_id: roomId, room_alias: alias } : { room_id: roomId };
  }

  async resolveRoomIdOrAlias(idOrAlias: string): Promise<string> {
    return (await this.resolveRoom(idOrAlias)).roomId;
  }

  /** Resolve a room ID or alias, including remote aliases; returns candidate servers for joining. */
  async resolveRoom(idOrAlias: string): Promise<{ roomId: string; servers: string[] }> {
    if (idOrAlias.startsWith("!")) return { roomId: idOrAlias, servers: [] };
    if (idOrAlias.startsWith("#")) {
      const row = await this.hs.db.findOne("room_aliases", [{ field: "alias", value: idOrAlias }]);
      if (row) return { roomId: row.room_id, servers: [this.hs.serverName] };
      const fromAppservice = this.hs.isLocalUser(idOrAlias) ? await this.hs.appservices.queryAlias(idOrAlias) : null;
      if (fromAppservice) return { roomId: fromAppservice, servers: [this.hs.serverName] };
      const server = parseId(idOrAlias, "#")?.server;
      if (server && server !== this.hs.serverName && this.hs.federation.enabled) {
        try {
          const res = await this.hs.federation.queryAlias(idOrAlias);
          return { roomId: res.room_id, servers: Array.isArray(res.servers) ? res.servers : [server] };
        } catch {
          throw errors.notFound("Room alias not found");
        }
      }
      throw errors.notFound("Room alias not found");
    }
    throw errors.invalidParam("Invalid room ID or alias");
  }

  /** Whether the room was created on this server and we still have its state. */
  async isLocallyHosted(roomId: string): Promise<boolean> {
    if (!(await this.exists(roomId))) return false;
    const create = await this.createEventOf(roomId);
    return !!create && this.hs.isLocalUser(create.sender);
  }

  /** Whether any local user is joined to the room (i.e. this server participates in it). */
  async serverIsJoined(roomId: string): Promise<boolean> {
    if (!(await this.exists(roomId))) return false;
    for (const [key, ev] of await this.currentState(roomId)) {
      const [type, userId] = splitStateKey(key);
      if (type === M.ROOM.MEMBER && ev.content?.membership === "join" && this.hs.isLocalUser(userId)) return true;
    }
    return false;
  }

  /** Servers that might help with a remote membership change for `userId` in `roomId`. */
  private async remoteServersFor(roomId: string, userId: string, extra: string[] = []): Promise<string[]> {
    const servers = [...extra];
    const row = await this.hs.db.findOne("memberships", [
      { field: "room_id", value: roomId },
      { field: "user_id", value: userId },
    ]);
    const ev = row ? await this.getPdu(row.event_id) : null;
    if (ev && !this.hs.isLocalUser(ev.sender)) servers.push(ev.sender.slice(ev.sender.indexOf(":") + 1));
    // Servers the client named take precedence; otherwise fall back to the room's own server and known members.
    if (!extra.length) {
      const roomServer = parseId(roomId, "!")?.server;
      if (roomServer) servers.push(roomServer);
      if (await this.exists(roomId)) for (const s of this.hs.federation.serversInRoom(await this.currentState(roomId))) servers.push(s);
    }
    return [...new Set(servers)].filter((s) => s !== this.hs.serverName);
  }

  /**
   * Record a membership event for a room this server may not participate in (remote
   * invites, rejections, knocks) so that it shows up in /sync.
   */
  async recordRemoteMembership(pdu: PDU, version: string): Promise<void> {
    void version;
    await this.hs.db.upsert("outliers", {
      event_id: pdu.event_id,
      room_id: pdu.room_id,
      json: pdu,
      state_snapshot: null,
      rejected: null,
      soft_failed: false,
    });
    this.outlierCache.delete(pdu.event_id!);
    if (!(await this.serverIsJoined(pdu.room_id))) {
      await this.hs.streams.write((stream) =>
        this.hs.db.upsert("memberships", {
          room_id: pdu.room_id,
          user_id: pdu.state_key,
          membership: pdu.content?.membership,
          event_id: pdu.event_id,
          stream,
          forgotten: false,
        }),
      );
    }
    this.sharingCache.clear();
    this.invalidate({ events: [pdu.event_id!], sharing: true });
    this.hs.notifier.notify([pdu.state_key!]);
  }

  async join(
    userId: string,
    roomId: string,
    extra: { reason?: string; content?: Record<string, any>; servers?: string[] } = {},
  ): Promise<string> {
    const version = await this.roomVersion(roomId);
    // https://github.com/k18k/katrix/issues/87 — improper authorization (CWE-285): guests could
    // join any room, also rooms whose admins keep guests out. The spec allows guests only in rooms whose
    // m.room.guest_access is can_join; a room we do not know cannot be checked, so guests cannot join it.
    if ((await this.hs.db.findOne("users", [{ field: "user_id", value: userId }]))?.is_guest) {
      const access = version ? getState(await this.currentState(roomId), M.ROOM.GUEST_ACCESS)?.content?.guest_access : undefined;
      if (access !== "can_join") throw errors.forbidden("Guest access is not allowed in this room");
    }
    // The client asked us to join via ourselves and we hold the room's state: decide locally.
    if (
      version &&
      !(await this.serverIsJoined(roomId)) &&
      extra.servers?.includes(this.hs.serverName) &&
      (await this.isLocallyHosted(roomId))
    ) {
      return this.joinLocal(userId, roomId, version, extra);
    }
    if (!version || !(await this.serverIsJoined(roomId))) {
      // A ban we know of cannot be lifted by joining through another server.
      if (version && (await this.membership(roomId, userId)) === "ban") throw errors.forbidden("You are banned from this room");
      const servers = await this.remoteServersFor(roomId, userId, extra.servers);
      if (!servers.length || !this.hs.federation.enabled) {
        if (version) {
          // We know the room but nobody here is in it, and there is no one to ask.
          return this.joinLocal(userId, roomId, version, extra);
        }
        throw errors.notFound("Room not found");
      }
      const content: Record<string, any> = { ...extra.content, membership: "join", ...(await this.hs.profile(userId)) };
      if (extra.reason) content.reason = extra.reason;
      this.hs.logger.debug("Remote join", userId, roomId, "via", servers);
      await this.hs.federation.joinRemoteRoom(userId, roomId, servers, content);
      const createEv = await this.createEventOf(roomId);
      const predecessor = createEv?.content?.predecessor?.room_id;
      if (typeof predecessor === "string") await copyRoomPushRules(this.hs, userId, predecessor, roomId);
      return roomId;
    }
    return this.joinLocal(userId, roomId, version, extra);
  }

  private async joinLocal(
    userId: string,
    roomId: string,
    version: string,
    extra: { reason?: string; content?: Record<string, any> },
  ): Promise<string> {
    this.hs.logger.debug("Local join", userId, roomId);
    const state = await this.currentState(roomId);
    const content: Record<string, any> = { ...extra.content, membership: "join", ...(await this.hs.profile(userId)) };
    if (extra.reason) content.reason = extra.reason;
    const existing = getState(state, M.ROOM.MEMBER, userId);
    if (existing?.content?.membership === "join" && JSON.stringify(existing.content) === JSON.stringify(content)) return roomId;
    const joinRule = getState(state, M.ROOM.JOIN_RULES)?.content?.join_rule;
    const current = membershipOf(state, userId);
    if ((joinRule === "restricted" || joinRule === "knock_restricted") && current !== "join" && current !== "invite") {
      const via = await this.findRestrictedAuthoriser(userId, state, version);
      if (via) {
        content.join_authorised_via_users_server = via;
      } else if (this.hs.federation.enabled && (await this.mayQualifyRemotely(userId, state))) {
        // No local user may authorise the join: go through a server whose members can.
        const pl = powerLevels(state, version);
        const servers = new Set<string>();
        for (const [k, ev] of state) {
          const [type, member] = splitStateKey(k);
          if (
            type === M.ROOM.MEMBER &&
            ev.content?.membership === "join" &&
            !this.hs.isLocalUser(member) &&
            userLevel(pl, member) >= pl.invite
          ) {
            servers.add(member.slice(member.indexOf(":") + 1));
          }
        }
        if (servers.size) {
          await this.hs.federation.joinRemoteRoom(userId, roomId, [...servers], content);
          return roomId;
        }
      }
    }
    await this.sendEvent(roomId, userId, { type: M.ROOM.MEMBER, state_key: userId, content });
    const predecessor = getState(state, M.ROOM.CREATE)?.content?.predecessor?.room_id;
    if (typeof predecessor === "string") await copyRoomPushRules(this.hs, userId, predecessor, roomId);
    return roomId;
  }

  /** Whether an allowed room exists that we can't check (or the user is joined to), so another server might authorise. */
  private async mayQualifyRemotely(userId: string, state: StateMap): Promise<boolean> {
    const allow = getState(state, M.ROOM.JOIN_RULES)?.content?.allow;
    if (!Array.isArray(allow)) return false;
    for (const rule of allow) {
      if (rule?.type !== M.ROOM_MEMBERSHIP || typeof rule.room_id !== "string") continue;
      if (!(await this.serverIsJoined(rule.room_id))) return true;
      if ((await this.membership(rule.room_id, userId)) === "join") return true;
    }
    return false;
  }

  private async findRestrictedAuthoriser(userId: string, state: StateMap, version: string): Promise<string | null> {
    const allow = getState(state, M.ROOM.JOIN_RULES)?.content?.allow;
    if (!Array.isArray(allow)) return null;
    let permitted = false;
    for (const rule of allow) {
      if (rule?.type === M.ROOM_MEMBERSHIP && typeof rule.room_id === "string" && (await this.exists(rule.room_id))) {
        if ((await this.membership(rule.room_id, userId)) === "join") {
          permitted = true;
          break;
        }
      }
    }
    if (!permitted) return null;
    const pl = powerLevels(state, version);
    for (const [k, ev] of state) {
      const [type, key] = splitStateKey(k);
      if (type === M.ROOM.MEMBER && ev.content?.membership === "join" && this.hs.isLocalUser(key) && userLevel(pl, key) >= pl.invite)
        return key;
    }
    return null;
  }

  async invite(
    roomId: string,
    sender: string,
    target: string,
    opts: { reason?: string; isDirect?: boolean; thirdPartyInvite?: { display_name: string; signed: Record<string, any> } } = {},
  ): Promise<void> {
    if (!isValidUserId(target)) throw errors.invalidParam("Invalid user ID");
    const local = this.hs.isLocalUser(target);
    if (
      local &&
      !(await this.hs.db.findOne("users", [{ field: "user_id", value: target }])) &&
      !(await this.hs.appservices.queryUser(target))
    ) {
      throw errors.notFound("Unknown user");
    }
    if (local && (await inviteDecision(this.hs, target, sender)) === "block") {
      throw errors.inviteBlocked();
    }
    await this.requireJoined(roomId, sender);
    const state = await this.currentState(roomId);
    if (membershipOf(state, target) === "invite") return; // Idempotent re-invite.
    const content: Record<string, any> = { membership: "invite" };
    if (local) Object.assign(content, await this.hs.profile(target));
    if (opts.reason) content.reason = opts.reason;
    if (opts.isDirect) content.is_direct = true;
    // An invite exchanged for an m.room.third_party_invite carries the identity server's proof.
    if (opts.thirdPartyInvite) content.third_party_invite = opts.thirdPartyInvite;
    if (local) {
      await this.sendEvent(roomId, sender, { type: M.ROOM.MEMBER, state_key: target, content });
      return;
    }
    if (!this.hs.federation.enabled) throw errors.forbidden("Federation is disabled");
    // Remote invites must be countersigned by the invitee's server first.
    await this.withLock(roomId, async () => {
      const version = (await this.roomVersion(roomId))!;
      const pdu = await this.buildLocalEvent(roomId, version, sender, { type: M.ROOM.MEMBER, state_key: target, content });
      const inviteState = [...this.strippedState(await this.currentState(roomId))];
      const senderMember = getState(await this.currentState(roomId), M.ROOM.MEMBER, sender);
      if (senderMember) {
        const { unsigned, ...full } = senderMember as PDU & Record<string, any>;
        inviteState.push(this.hs.federation.toFederationPdu(full as PDU, version));
      }
      const signed = await this.hs.federation.sendInvite(pdu, version, inviteState);
      await this.persistEvent(roomId, version, signed, { local: true });
    });
  }

  /** Make this server's guests leave a room that no longer allows guests (spec, guest access module; #87). */
  private async removeGuests(roomId: string): Promise<void> {
    for (const [k, ev] of await this.currentState(roomId)) {
      const [type, userId] = splitStateKey(k);
      if (type !== M.ROOM.MEMBER || ev.content?.membership !== "join" || !this.hs.isLocalUser(userId)) continue;
      if ((await this.hs.db.findOne("users", [{ field: "user_id", value: userId }]))?.is_guest)
        await this.setMembership(roomId, userId, userId, "leave");
    }
  }

  async setMembership(
    roomId: string,
    sender: string,
    target: string,
    membership: "leave" | "ban" | "knock",
    reason?: string,
    via: string[] = [],
  ): Promise<void> {
    // Rejecting invites / rescinding knocks / knocking on rooms we don't participate in goes over federation.
    // (A room we hold locally, e.g. an invite to an empty local room, is handled with a local event.)
    const remote = !(await this.serverIsJoined(roomId)) && (membership === "knock" || !(await this.isLocallyHosted(roomId)));
    if (sender === target && (membership === "leave" || membership === "knock") && remote) {
      await this.remoteMembership(roomId, target, membership, reason, via);
      return;
    }
    if (!(await this.exists(roomId))) throw errors.notFound("Room not found");
    const content: Record<string, any> = { membership };
    if (reason) content.reason = reason;
    if (membership === "ban" || (membership === "leave" && sender !== target)) {
      const prev = getState(await this.currentState(roomId), M.ROOM.MEMBER, target);
      if (prev?.content?.displayname) content.displayname = prev.content.displayname;
    }
    await this.sendEvent(roomId, sender, { type: M.ROOM.MEMBER, state_key: target, content });
  }

  private async remoteMembership(
    roomId: string,
    userId: string,
    membership: "leave" | "knock",
    reason?: string,
    via: string[] = [],
  ): Promise<void> {
    const row = await this.hs.db.findOne("memberships", [
      { field: "room_id", value: roomId },
      { field: "user_id", value: userId },
    ]);
    if (membership === "leave" && (!row || row.membership === "leave" || row.membership === "ban")) {
      if (!(await this.exists(roomId))) throw errors.notFound("Room not found");
      if (row?.membership === "ban") throw errors.forbidden("You are banned from this room");
      return;
    }
    const servers = await this.remoteServersFor(roomId, userId, via);
    if (membership === "knock") {
      if (!servers.length || !this.hs.federation.enabled) throw errors.notFound("Room not found");
      const { pdu, knockState } = await this.hs.federation.knockRemoteRoom(userId, roomId, servers, reason);
      await this.recordRemoteMembership({ ...pdu, unsigned: { knock_room_state: knockState } }, "");
      return;
    }
    let leave: PDU;
    try {
      if (!servers.length || !this.hs.federation.enabled) throw new Error("No servers to contact");
      leave = await this.hs.federation.leaveRemoteRoom(userId, roomId, servers, reason);
    } catch (err) {
      // The remote side is unreachable: reject locally so the user is not stuck with the invite.
      this.hs.logger.debug("Remote leave failed, rejecting locally", err);
      const content: Record<string, any> = { membership: "leave" };
      if (reason) content.reason = reason;
      leave = finalisePdu(
        {
          room_id: roomId,
          sender: userId,
          type: M.ROOM.MEMBER,
          state_key: userId,
          content,
          origin_server_ts: Date.now(),
          depth: 1,
          prev_events: row ? [row.event_id] : [],
          auth_events: [],
        } as PDU,
        DEFAULT_ROOM_VERSION,
        this.hs.serverName,
        this.hs.signingKey,
      );
    }
    await this.recordRemoteMembership(leave, "");
  }

  /** Update the member event in every joined room after a profile change. */
  async propagateProfile(userId: string): Promise<void> {
    const profile = await this.hs.profile(userId);
    for (const roomId of await this.roomsForUser(userId)) {
      const prev = getState(await this.currentState(roomId), M.ROOM.MEMBER, userId);
      if (!prev) continue;
      const content = { ...prev.content, membership: "join", ...profile };
      if (profile.displayname === undefined) delete content.displayname;
      if (profile.avatar_url === undefined) delete content.avatar_url;
      try {
        await this.sendEvent(roomId, userId, { type: M.ROOM.MEMBER, state_key: userId, content });
      } catch (err) {
        this.hs.logger.warn("Failed to propagate profile to", roomId, err);
      }
    }
  }
}
