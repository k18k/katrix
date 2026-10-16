import { MatrixError, errors } from "#core/errors.ts";
import { globMatch } from "#core/glob.ts";
import { getState, membershipOf, type StateMap } from "#core/authrules.ts";
import {
  SUPPORTED_ROOM_VERSIONS,
  computeContentHash,
  computeReferenceHash,
  eventIdOf,
  finalisePdu,
  redact,
  roomVersionFeatures,
  splitStateKey,
  stateKey,
  stripState,
  type PDU,
} from "#core/events.ts";
import { unpaddedBase64, urlSafeBase64 } from "#core/crypto.ts";
import { isObject } from "#core/json.ts";
import { parseId } from "#core/ids.ts";
import { MissingStateError } from "#core/rooms.ts";
import { authStateFromAuthEvents, checkAuth } from "#core/authrules.ts";
import { resolveState } from "#core/stateres.ts";
import type { Homeserver } from "#homeserver.ts";
import { FederationClient } from "#federation/client.ts";
import { KeyRing } from "#federation/keyring.ts";
import { TransactionSender } from "#federation/sender.ts";
import { M } from "#core/m.ts";

export interface FederationOptions {
  /** Enable federation (talking to other homeservers). Default: false, so that a server only joins the network on purpose. */
  enabled?: boolean;
  /** Join remote rooms with partial state first (MSC3902 "faster joins"). Default true. */
  fasterJoins?: boolean;
  /** Verify remote TLS certificates. Default: true. Disable only for development. */
  verifyTls?: boolean;
  /** Only federate with these servers (allow list). */
  allowedServers?: string[];
  /** Never federate with these servers. */
  blockedServers?: string[];
}

export const domainOf = (id: string) => id.slice(id.indexOf(":") + 1);

/** Server ACL check (m.room.server_acl). */
export function serverAllowedByAcl(state: StateMap, serverName: string): boolean {
  const acl = getState(state, M.ROOM.SERVER_ACL)?.content;
  if (!isObject(acl)) return true;
  const host = serverName.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (acl.allow_ip_literals === false && (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":"))) return false;
  // Security (https://github.com/k18k/matrix-nodejs-homeserver/issues/2): ACL entries come from room state, i.e. from any member allowed to set
  // them. Compiled to regexes they allowed catastrophic backtracking that hung the server (ReDoS);
  // they are matched in linear time instead (core/glob.ts).
  const matches = (p: unknown) => typeof p === "string" && globMatch(p, host, { caseInsensitive: true });
  if (Array.isArray(acl.deny) && acl.deny.some(matches)) return false;
  if (!Array.isArray(acl.allow)) return false;
  return acl.allow.some(matches);
}

/** Server-server API: verification, inbound processing and outbound requests. */
export class FederationService {
  private hs: Homeserver;
  readonly enabled: boolean;
  readonly fasterJoins: boolean;
  readonly client: FederationClient;
  readonly keyring: KeyRing;
  readonly sender: TransactionSender;
  private options: FederationOptions;
  private seenTxns = new Map<string, Promise<Record<string, any>>>();
  private deviceStreams = new Map<string, number>();

  constructor(hs: Homeserver, options: FederationOptions = {}) {
    this.hs = hs;
    this.options = options;
    this.enabled = options.enabled === true;
    this.fasterJoins = options.fasterJoins !== false;
    this.client = new FederationClient(hs, { rejectUnauthorized: options.verifyTls !== false });
    this.keyring = new KeyRing(hs);
    this.sender = new TransactionSender(hs);
  }

  serverAllowed(serverName: string): boolean {
    if (this.options.blockedServers?.includes(serverName)) return false;
    if (this.options.allowedServers && !this.options.allowedServers.includes(serverName)) return false;
    return true;
  }

  private requireEnabled(): void {
    if (!this.enabled) throw errors.forbidden("Federation is disabled");
  }

  // ---------------------------------------------------------------------------
  // PDU format and verification
  // ---------------------------------------------------------------------------

  /** Convert a stored event into its federation (wire) format. */
  toFederationPdu(pdu: PDU, version: string): Record<string, any> {
    const { unsigned, ...rest } = pdu as PDU & Record<string, any>;
    const out: Record<string, any> = { ...rest };
    const f = roomVersionFeatures(version);
    if (!f.legacyEventIds) delete out.event_id;
    if (f.v12 && out.type === M.ROOM.CREATE) delete out.room_id;
    return out;
  }

  computeEventId(raw: Record<string, any>, version: string): string {
    const f = roomVersionFeatures(version);
    if (f.legacyEventIds) return raw.event_id;
    const hash = computeReferenceHash(raw, version);
    return `$${f.urlSafeEventIds ? urlSafeBase64(hash) : unpaddedBase64(hash)}`;
  }

  /**
   * Verify an incoming PDU: event ID, signatures and content hash. Events with a bad
   * content hash are redacted (as the spec requires) rather than rejected.
   */
  async verifyPdu(
    raw: Record<string, any>,
    version: string,
    roomId: string,
  ): Promise<{ pdu: PDU; joinAuthorisedSignatureValid?: boolean }> {
    if (!isObject(raw) || typeof raw.type !== "string" || typeof raw.sender !== "string" || !isObject(raw.content)) {
      throw errors.badJson("Malformed PDU");
    }
    const f = roomVersionFeatures(version);
    if (!f.v12 || raw.type !== M.ROOM.CREATE) {
      if (raw.room_id !== roomId) throw errors.badJson("PDU room_id mismatch");
    }
    const eventId = this.computeEventId(raw, version);
    if (typeof eventId !== "string") throw errors.badJson("Missing event ID");
    const redacted = redact(raw, version);
    const senderDomain = domainOf(raw.sender);
    if (!(await this.keyring.verifySignedBy(redacted, senderDomain, raw.origin_server_ts))) {
      throw errors.forbidden(`Event ${eventId} is not signed by ${senderDomain}`);
    }
    if (f.legacyEventIds && domainOf(eventId) !== senderDomain && !(await this.keyring.verifySignedBy(redacted, domainOf(eventId)))) {
      throw errors.forbidden(`Event ${eventId} is not signed by its origin`);
    }
    let joinAuthorisedSignatureValid: boolean | undefined;
    const via = raw.content?.join_authorised_via_users_server;
    if (f.restricted && raw.type === M.ROOM.MEMBER && raw.content?.membership === "join" && typeof via === "string" && via.includes(":")) {
      joinAuthorisedSignatureValid = await this.keyring.verifySignedBy(redacted, domainOf(via));
    }
    let pdu: PDU = { ...(raw as PDU), event_id: eventId };
    if (raw.hashes?.sha256 !== computeContentHash(raw)) {
      pdu = { ...(redact(raw, version) as PDU), event_id: eventId };
    }
    if (f.v12 && pdu.type === M.ROOM.CREATE) pdu.room_id = roomId;
    return { pdu, joinAuthorisedSignatureValid };
  }

  // ---------------------------------------------------------------------------
  // Outbound fan-out
  // ---------------------------------------------------------------------------

  /** Servers with joined members in a room (excluding ourselves). */
  serversInRoom(state: StateMap, applyAcl = true): Set<string> {
    const servers = new Set<string>();
    for (const [key, ev] of state) {
      const [type, userId] = splitStateKey(key);
      if (type === M.ROOM.MEMBER && ev.content?.membership === "join") servers.add(domainOf(userId));
    }
    servers.delete(this.hs.serverName);
    for (const s of servers) if (!this.serverAllowed(s) || (applyAcl && !serverAllowedByAcl(state, s))) servers.delete(s);
    return servers;
  }

  /**
   * Servers to send a room's traffic to: joined servers per the state, plus, while the room's
   * state is partial (MSC3902), the servers the resident server said were in the room.
   */
  async roomDestinations(roomId: string, state: StateMap, applyAcl = true): Promise<Set<string>> {
    const destinations = this.serversInRoom(state, applyAcl);
    for (const s of await this.hs.partialState.servers(roomId)) {
      if (s !== this.hs.serverName && this.serverAllowed(s) && (!applyAcl || serverAllowedByAcl(state, s))) destinations.add(s);
    }
    return destinations;
  }

  /** Send a newly created local event to every server in the room. */
  onLocalEvent(pdu: PDU, state: StateMap): void {
    if (!this.enabled) return;
    void (async () => {
      // A server denied by a new ACL still needs to receive the ACL event itself.
      const destinations = await this.roomDestinations(pdu.room_id, state, pdu.type !== M.ROOM.SERVER_ACL);
      // Members leaving or being kicked/banned should hear about it too.
      if (pdu.type === M.ROOM.MEMBER && typeof pdu.state_key === "string" && !this.hs.isLocalUser(pdu.state_key)) {
        destinations.add(domainOf(pdu.state_key));
      }
      if (!destinations.size) return;
      const version = (await this.hs.rooms.roomVersion(pdu.room_id)) ?? "10";
      await this.sender.sendPdu(destinations, this.toFederationPdu(pdu, version));
    })().catch((err) => this.hs.logger.warn("Failed to queue PDU", err));
  }

  /** Send an EDU to every server in the given rooms. */
  async sendEduToRooms(roomIds: string[], eduType: string, content: Record<string, any>, durable = true): Promise<void> {
    if (!this.enabled) return;
    const destinations = new Set<string>();
    for (const roomId of roomIds) {
      if (!(await this.hs.rooms.exists(roomId))) continue;
      for (const s of await this.roomDestinations(roomId, await this.hs.rooms.currentState(roomId))) destinations.add(s);
    }
    if (destinations.size) await this.sender.sendEdu(destinations, eduType, content, durable);
  }

  /** Servers sharing a room with a local user. */
  async serversSharingRooms(userId: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const roomId of await this.hs.rooms.roomsForUser(userId)) {
      for (const s of await this.roomDestinations(roomId, await this.hs.rooms.currentState(roomId))) out.add(s);
    }
    return out;
  }

  async onTyping(roomId: string, userId: string, typing: boolean): Promise<void> {
    if (this.hs.isLocalUser(userId)) await this.sendEduToRooms([roomId], M.TYPING, { room_id: roomId, user_id: userId, typing }, false);
  }

  async onReceipt(roomId: string, userId: string, receiptType: string, eventId: string, ts: number, threadId: string): Promise<void> {
    if (!this.hs.isLocalUser(userId) || receiptType === M.READ.PRIVATE) return;
    const data: Record<string, any> = { ts };
    if (threadId) data.thread_id = threadId;
    await this.sendEduToRooms([roomId], M.RECEIPT, { [roomId]: { [receiptType]: { [userId]: { event_ids: [eventId], data } } } });
  }

  async onPresence(userId: string, presence: string, statusMsg: string | null): Promise<void> {
    if (!this.enabled || !this.hs.isLocalUser(userId)) return;
    const servers = await this.serversSharingRooms(userId);
    if (!servers.size) return;
    await this.sender.sendEdu(
      servers,
      M.PRESENCE,
      {
        push: [
          {
            user_id: userId,
            presence,
            last_active_ago: 0,
            currently_active: presence === "online",
            ...(statusMsg ? { status_msg: statusMsg } : {}),
          },
        ],
      },
      false,
    );
  }

  /** Tell servers sharing rooms with a local user that their device list changed. */
  async onDeviceListChange(userId: string, deletedDeviceId?: string, to?: Set<string>): Promise<void> {
    if (!this.enabled || !this.hs.isLocalUser(userId)) return;
    const servers = to ?? (await this.serversSharingRooms(userId));
    if (!servers.size) return;
    const devices = await this.hs.db.findMany("devices", { where: [{ field: "user_id", value: userId }] });
    const updates: { deviceId: string; deleted: boolean }[] = devices.map((d) => ({ deviceId: d.device_id, deleted: false }));
    if (deletedDeviceId) updates.push({ deviceId: deletedDeviceId, deleted: true });
    for (const u of updates) {
      const prev =
        this.deviceStreams.get(userId) ??
        (await this.hs.db.findOne("device_list_changes", [{ field: "user_id", value: userId }]))?.stream ??
        0;
      const streamId = Math.max(await this.hs.streams.write(async (id) => id), prev + 1);
      this.deviceStreams.set(userId, streamId);
      const content: Record<string, any> = { user_id: userId, device_id: u.deviceId, stream_id: streamId, prev_id: prev ? [prev] : [] };
      if (u.deleted) content.deleted = true;
      else {
        const keys = await this.hs.db.findOne("device_keys", [
          { field: "user_id", value: userId },
          { field: "device_id", value: u.deviceId },
        ]);
        if (keys) content.keys = keys.keys;
        const d = devices.find((x) => x.device_id === u.deviceId);
        if (d?.display_name) content.device_display_name = d.display_name;
      }
      await this.sender.sendEdu(servers, M.DEVICE_LIST_UPDATE, content);
    }
  }

  async onSigningKeyUpdate(userId: string): Promise<void> {
    if (!this.enabled || !this.hs.isLocalUser(userId)) return;
    const servers = await this.serversSharingRooms(userId);
    if (!servers.size) return;
    const rows = await this.hs.db.findMany("cross_signing_keys", { where: [{ field: "user_id", value: userId }] });
    const content: Record<string, any> = { user_id: userId };
    for (const r of rows) if (r.key_type !== "user_signing") content[`${r.key_type}_key`] = r.key;
    await this.sender.sendEdu(servers, M.SIGNING_KEY_UPDATE, content);
  }

  /** Deliver to-device messages addressed to remote users. */
  async sendToDevice(sender: string, type: string, messages: Record<string, Record<string, any>>, messageId: string): Promise<void> {
    if (!this.enabled) return;
    const byServer = new Map<string, Record<string, any>>();
    for (const [userId, devices] of Object.entries(messages)) {
      const server = domainOf(userId);
      if (server === this.hs.serverName || !this.serverAllowed(server)) continue;
      (byServer.get(server) ?? byServer.set(server, {}).get(server)!)[userId] = devices;
    }
    for (const [server, msgs] of byServer) {
      await this.sender.sendEdu([server], M.DIRECT_TO_DEVICE, { sender, type, message_id: `${messageId}-${server}`, messages: msgs });
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound transactions
  // ---------------------------------------------------------------------------

  async receiveTransaction(origin: string, txnId: string, body: Record<string, any>): Promise<Record<string, any>> {
    const key = `fedtxn:${origin}|${txnId}`;
    void this.sender.wake(origin);
    // Retries of a transaction (possibly hitting another instance) get the original result.
    const local = this.seenTxns.get(key);
    if (local) return local;
    const done = await this.hs.cluster.get<Record<string, any>>(key);
    if (done) return done;
    const p = this.hs.cluster.lock(key, async () => {
      const again = await this.hs.cluster.get<Record<string, any>>(key);
      if (again) return again;
      const result = await this.processTransaction(origin, body);
      await this.hs.cluster.set(key, result, 24 * 3600_000);
      return result;
    });
    this.seenTxns.set(key, p);
    if (this.seenTxns.size > 1_000) this.seenTxns.delete(this.seenTxns.keys().next().value!);
    return p;
  }

  private async processTransaction(origin: string, body: Record<string, any>): Promise<Record<string, any>> {
    const pdus = Array.isArray(body.pdus) ? body.pdus.slice(0, 50) : [];
    const edus = Array.isArray(body.edus) ? body.edus.slice(0, 100) : [];
    const results: Record<string, any> = {};
    for (const raw of pdus) {
      const roomId = typeof raw?.room_id === "string" ? raw.room_id : null;
      let eventId = "unknown";
      try {
        if (!roomId) throw errors.badJson("PDU without room_id");
        const version = await this.hs.rooms.roomVersion(roomId);
        if (!version) {
          eventId = await this.handleOutOfRoomMembership(origin, roomId, raw);
          results[eventId] = {};
          continue;
        }
        eventId = this.computeEventId(raw, version);
        await this.hs.rooms.withLock(roomId, () => this.handlePdu(origin, roomId, version, raw));
        results[eventId] = {};
      } catch (err) {
        results[eventId] = { error: err instanceof Error ? err.message : String(err) };
        this.hs.logger.debug("PDU from", origin, "failed", err);
      }
    }
    for (const edu of edus) {
      try {
        await this.handleEdu(origin, edu);
      } catch (err) {
        this.hs.logger.debug("EDU from", origin, "failed", err);
      }
    }
    return { pdus: results };
  }

  /**
   * A PDU for a room we are not in can still matter: a local user's invite being
   * rescinded or their knock being accepted/rejected.
   */
  private async handleOutOfRoomMembership(origin: string, roomId: string, raw: Record<string, any>): Promise<string> {
    if (raw?.type !== M.ROOM.MEMBER || typeof raw.state_key !== "string" || !this.hs.isLocalUser(raw.state_key)) {
      throw errors.notFound("Unknown room");
    }
    const row = await this.hs.db.findOne("memberships", [
      { field: "room_id", value: roomId },
      { field: "user_id", value: raw.state_key },
    ]);
    if (!row) throw errors.notFound("Unknown room");
    const previous = await this.hs.rooms.getPdu(row.event_id);
    const create = (previous?.unsigned?.invite_room_state ?? previous?.unsigned?.knock_room_state ?? []).find(
      (e: any) => e?.type === M.ROOM.CREATE,
    );
    const version = typeof create?.content?.room_version === "string" ? create.content.room_version : "1";
    const { pdu } = await this.verifyPdu(raw, version, roomId);
    if (domainOf(pdu.sender) !== origin && domainOf(pdu.sender) !== domainOf(raw.state_key)) throw errors.forbidden("Unexpected sender");
    const membership = pdu.content?.membership;
    // Only the original inviter (or the user themselves) can rescind an invite.
    if (
      row.membership === "invite" &&
      (membership === "leave" || membership === "ban") &&
      previous &&
      pdu.sender !== previous.sender &&
      pdu.sender !== raw.state_key
    ) {
      return pdu.event_id!;
    }
    if (membership === "invite" || membership === "join") {
      // A knock was accepted (invite) — keep the stripped state from the knock for the client.
      pdu.unsigned = {
        ...pdu.unsigned,
        invite_room_state: previous?.unsigned?.knock_room_state ?? previous?.unsigned?.invite_room_state ?? [],
      };
    }
    if (membership !== "join") await this.hs.rooms.recordRemoteMembership(pdu, version);
    return pdu.event_id!;
  }

  /** Process one incoming PDU (caller holds the room lock). */
  async handlePdu(origin: string, roomId: string, version: string, raw: Record<string, any>, depth = 0): Promise<void> {
    const state = await this.hs.rooms.currentState(roomId);
    if (!serverAllowedByAcl(state, origin)) throw errors.forbidden("Server is denied by the room's ACL");
    const { pdu, joinAuthorisedSignatureValid } = await this.verifyPdu(raw, version, roomId);
    if (await this.hs.rooms.getEvent(pdu.event_id!)) return;
    // An event authorised by a known-rejected event is rejected too; no need to look for its predecessors.
    for (const id of (pdu.auth_events ?? []).map(eventIdOf)) {
      const outlier = await this.hs.rooms.getOutlier(id);
      if (outlier?.rejected) {
        await this.hs.db.upsert("outliers", {
          event_id: pdu.event_id,
          room_id: roomId,
          json: pdu,
          state_snapshot: null,
          soft_failed: false,
          rejected: `Auth event ${id} was rejected`,
        });
        return;
      }
    }

    let stateBefore: Record<string, string> | undefined;
    const prevIds = (pdu.prev_events ?? []).map(eventIdOf);
    const unknownPrevs = async () => {
      const out: string[] = [];
      for (const id of prevIds) {
        if ((await this.hs.rooms.snapshotOf(id)) !== null) continue;
        // Rejected predecessors are known; they are simply ignored when computing state.
        if ((await this.hs.rooms.getOutlier(id))?.rejected) continue;
        out.push(id);
      }
      return out;
    };
    let missing = await unknownPrevs();
    if (missing.length && depth < 3) {
      // If the remote server answers with invalid events, drop this PDU rather than guessing state.
      if (!(await this.fetchMissingPrevEvents(origin, roomId, version, pdu))) return;
      missing = await unknownPrevs();
    }
    if (missing.length && depth === 0) {
      // A pushed event whose predecessors the sender would not supply could otherwise become the
      // only forward extremity, making us trust whatever state it claims. Refuse it (as Synapse does);
      // only events we pulled via /get_missing_events get their state from /state_ids.
      throw errors.forbidden("Your server isn't divulging details about prev_events referenced in this event.");
    }
    if (missing.length) stateBefore = await this.stateFromPrevs(origin, roomId, version, prevIds);

    // Auth events still unknown after filling the gap (which usually brings the auth chain along)
    // are fetched explicitly; an event whose auth events stay unavailable is rejected.
    await this.fetchMissingAuthEvents(origin, roomId, version, pdu);
    for (const id of (pdu.auth_events ?? []).map(eventIdOf)) {
      const outlier = await this.hs.rooms.getOutlier(id);
      if (outlier?.rejected || !(await this.hs.rooms.knowsEvent(id))) {
        await this.hs.db.upsert("outliers", {
          event_id: pdu.event_id,
          room_id: roomId,
          json: pdu,
          state_snapshot: null,
          soft_failed: false,
          rejected: outlier?.rejected ? `Auth event ${id} was rejected` : `Auth event ${id} is unavailable`,
        });
        return;
      }
    }

    try {
      const result = await this.hs.rooms.persistEvent(roomId, version, pdu, {
        joinAuthorisedSignatureValid,
        stateBefore,
        gap: !!stateBefore,
      });
      if (result.status === "rejected") this.hs.logger.debug("Rejected", pdu.event_id, result.reason);
    } catch (err) {
      if (err instanceof MissingStateError && !stateBefore && depth > 0) {
        const sb = await this.stateFromPrevs(origin, roomId, version, prevIds);
        await this.hs.rooms.persistEvent(roomId, version, pdu, { joinAuthorisedSignatureValid, stateBefore: sb, gap: true });
      } else {
        throw err;
      }
    }
  }

  /**
   * State before an event whose predecessors we lack: for each unknown prev event,
   * fetch the state at it (/state_ids) plus the event itself, then resolve all
   * predecessors' states. Throws if a required event cannot be fetched.
   */
  async stateFromPrevs(
    origin: string,
    roomId: string,
    version: string,
    prevIds: string[],
    opts: { remote?: boolean } = {},
  ): Promise<Record<string, string>> {
    const sets: Record<string, string>[] = [];
    for (const prev of prevIds) {
      // `remote`: our own view of the state is incomplete (partial-state join), so always ask.
      const snap = opts.remote ? null : await this.hs.rooms.snapshotOf(prev);
      if (snap !== null) {
        sets.push(await this.hs.rooms.snapshotIds(snap));
        continue;
      }
      if ((await this.hs.rooms.getOutlier(prev))?.rejected) continue;
      const before = await this.fetchStateBefore(origin, roomId, version, prev);
      if (!(await this.hs.rooms.getPdu(prev))) await this.fetchEvent(origin, roomId, version, prev);
      const prevPdu = await this.hs.rooms.getPdu(prev);
      if (!prevPdu) throw errors.notFound(`Could not fetch prev event ${prev}`);
      sets.push(prevPdu.state_key !== undefined ? { ...before, [stateKey(prevPdu.type, prevPdu.state_key)]: prev } : before);
    }
    if (!sets.length) throw errors.forbidden("All predecessors were rejected");
    if (sets.length === 1) return sets[0];
    const create = roomVersionFeatures(version).v12 ? ((await this.hs.rooms.getPdu(`$${roomId.slice(1)}`)) ?? undefined) : undefined;
    return resolveState(sets, version, (ids) => this.hs.rooms.getPdus(ids), create);
  }

  private async fetchMissingAuthEvents(origin: string, roomId: string, version: string, pdu: PDU): Promise<void> {
    const authIds = (pdu.auth_events ?? []).map(eventIdOf);
    const missing = [];
    for (const id of authIds) if (!(await this.hs.rooms.knowsEvent(id))) missing.push(id);
    if (!missing.length) return;
    try {
      const res = await this.client.request(
        origin,
        "GET",
        `/_matrix/federation/v1/event_auth/${encodeURIComponent(roomId)}/${encodeURIComponent(pdu.event_id!)}`,
      );
      await this.storeOutliers(roomId, version, Array.isArray(res.auth_chain) ? res.auth_chain : []);
    } catch {
      // Fall back to fetching the missing auth events (and their auth events) one by one.
      const seen = new Set<string>();
      const raws: Record<string, any>[] = [];
      let queue = missing;
      while (queue.length && seen.size < 100) {
        const next: string[] = [];
        for (const id of queue) {
          if (seen.has(id) || (await this.hs.rooms.knowsEvent(id))) continue;
          seen.add(id);
          const raw = await this.fetchRawEvent(origin, id).catch(() => null);
          if (!raw) continue;
          raws.push(raw);
          for (const a of (raw.auth_events ?? []).map(eventIdOf)) next.push(a);
        }
        queue = next;
      }
      await this.storeOutliers(roomId, version, raws);
    }
  }

  /** Fill a gap with /get_missing_events. Returns false when the response contained invalid events. */
  private async fetchMissingPrevEvents(origin: string, roomId: string, version: string, pdu: PDU): Promise<boolean> {
    const earliest = await this.hs.rooms.extremities(roomId);
    let res: any;
    try {
      res = await this.client.request(origin, "POST", `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(roomId)}`, {
        body: { earliest_events: earliest, latest_events: [pdu.event_id], limit: 10, min_depth: 0 },
      });
    } catch {
      return true;
    }
    const events = (Array.isArray(res.events) ? res.events : []).filter(isObject);
    for (const ev of events) {
      try {
        this.computeEventId(ev, version);
      } catch {
        return false;
      }
    }
    events.sort((a: any, b: any) => (a.depth ?? 0) - (b.depth ?? 0));
    const failed = new Set<string>();
    for (const ev of events) {
      try {
        await this.handlePdu(origin, roomId, version, ev, 3);
      } catch (err) {
        failed.add(this.computeEventId(ev, version));
        this.hs.logger.debug("Missing event failed", err);
      }
    }
    // If a predecessor we were just given could not be processed (e.g. its state was
    // unobtainable), asking again for the state at it would fail the same way: drop the event.
    return !(pdu.prev_events ?? []).map(eventIdOf).some((id) => failed.has(id));
  }

  /** Fetch one event from a remote server and store it as an outlier. */
  private async fetchEvent(origin: string, roomId: string, version: string, eventId: string): Promise<void> {
    const raw = await this.fetchRawEvent(origin, eventId);
    if (raw) await this.storeOutliers(roomId, version, [raw]);
  }

  private async fetchRawEvent(origin: string, eventId: string): Promise<Record<string, any> | null> {
    const r = await this.client.request(origin, "GET", `/_matrix/federation/v1/event/${encodeURIComponent(eventId)}`);
    return Array.isArray(r.pdus) && isObject(r.pdus[0]) ? r.pdus[0] : null;
  }

  /**
   * Fetch the state before an event from a remote server. Uses /state_ids and
   * fetches only unknown events (falling back to /state), storing them as outliers.
   */
  async fetchStateBefore(origin: string, roomId: string, version: string, eventId: string): Promise<Record<string, string>> {
    let stateIds: string[];
    let res: any = null;
    // Computing the state of a large room can take the remote server a while.
    const timeoutMs = 300_000;
    try {
      res = await this.client.request(origin, "GET", `/_matrix/federation/v1/state_ids/${encodeURIComponent(roomId)}`, {
        query: { event_id: eventId },
        timeoutMs,
      });
    } catch (err) {
      this.hs.logger.debug("/state_ids failed, falling back to /state", origin, err);
    }
    // A response without state is useless (and must not be mistaken for "the room has no state").
    if (res && (!Array.isArray(res.pdu_ids) || !res.pdu_ids.length)) throw errors.notFound("Remote server returned no state");
    if (res) {
      stateIds = res.pdu_ids;
      const wanted = [...(Array.isArray(res.auth_chain_ids) ? res.auth_chain_ids : []), ...stateIds];
      const missing: string[] = [];
      for (const id of wanted) if (typeof id === "string" && !(await this.hs.rooms.knowsEvent(id))) missing.push(id);
      // Fetch in parallel batches; auth chain first so that dependencies are stored before dependents.
      // Fetch everything first, then store in depth order so auth events precede dependents.
      const raws: Record<string, any>[] = [];
      for (let i = 0; i < missing.length; i += 20) {
        const batch = await Promise.all(missing.slice(i, i + 20).map((id) => this.fetchRawEvent(origin, id).catch(() => null)));
        for (const raw of batch) if (raw) raws.push(raw);
      }
      await this.storeOutliers(roomId, version, raws);
      // Every state event must be available; otherwise the state cannot be trusted.
      for (const id of stateIds) if (!(await this.hs.rooms.knowsEvent(id))) throw errors.notFound(`Could not fetch state event ${id}`);
    } else {
      const res = await this.client.request(origin, "GET", `/_matrix/federation/v1/state/${encodeURIComponent(roomId)}`, {
        query: { event_id: eventId },
        timeoutMs,
      });
      const pdus: any[] = Array.isArray(res.pdus) ? res.pdus : [];
      if (!pdus.length) throw errors.notFound("Remote server returned no state");
      await this.storeOutliers(roomId, version, [...(Array.isArray(res.auth_chain) ? res.auth_chain : []), ...pdus]);
      stateIds = pdus.filter(isObject).map((raw) => this.computeEventId(raw, version));
    }
    const ids: Record<string, string> = {};
    const pdus = await this.hs.rooms.getPdus(stateIds);
    for (const id of stateIds) {
      const pdu = pdus.get(id);
      if (pdu && pdu.state_key !== undefined) ids[stateKey(pdu.type, pdu.state_key)] = id;
    }
    return ids;
  }

  /** Verify and store events that are not (yet) part of the timeline. */
  async storeOutliers(roomId: string, version: string, raws: unknown[]): Promise<void> {
    const verified: PDU[] = [];
    for (const raw of raws) {
      if (!isObject(raw)) continue;
      try {
        const { pdu } = await this.verifyPdu(raw, version, roomId);
        if (!(await this.hs.rooms.knowsEvent(pdu.event_id!))) verified.push(pdu);
      } catch (err) {
        this.hs.logger.debug("Dropping invalid outlier", err);
      }
    }
    verified.sort((a, b) => a.depth - b.depth);
    const seen = new Set<string>();
    for (const pdu of verified) {
      if (seen.has(pdu.event_id!)) continue;
      seen.add(pdu.event_id!);
      const rejected = await this.checkOutlierAuth(roomId, version, pdu);
      await this.hs.db.upsert("outliers", {
        event_id: pdu.event_id,
        room_id: roomId,
        json: pdu,
        state_snapshot: null,
        rejected,
        soft_failed: false,
      });
    }
  }

  /** Check an outlier against its own auth events. Returns a rejection reason, or null. */
  private async checkOutlierAuth(roomId: string, version: string, pdu: PDU): Promise<string | null> {
    const authIds = (pdu.auth_events ?? []).map(eventIdOf);
    const authPdus: PDU[] = [];
    for (const id of authIds) {
      const outlier = await this.hs.rooms.getOutlier(id);
      if (outlier?.rejected) return `Auth event ${id} was rejected`;
      const p = await this.hs.rooms.getPdu(id);
      if (!p) return `Auth event ${id} is unavailable`;
      authPdus.push(p);
    }
    try {
      const create =
        roomVersionFeatures(version).v12 && pdu.type !== M.ROOM.CREATE
          ? ((await this.hs.rooms.getPdu(`$${roomId.slice(1)}`)) ?? undefined)
          : undefined;
      checkAuth(pdu, authStateFromAuthEvents(pdu, authPdus, version, create), version);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  // ---------------------------------------------------------------------------
  // EDUs
  // ---------------------------------------------------------------------------

  /**
   * Whether a remote user's ephemeral activity (typing, receipts) in a room is accepted: they are
   * joined, or the room's state is partial (MSC3902) and their server is one of the room's servers.
   */
  private async mayActInRoom(roomId: string, userId: string, origin: string): Promise<boolean> {
    const membership = await this.hs.rooms.membership(roomId, userId);
    if (membership === "join") return true;
    if (membership !== "leave" || !(await this.hs.partialState.isPartial(roomId))) return false;
    return (await this.hs.partialState.servers(roomId)).includes(origin);
  }

  async handleEdu(origin: string, edu: Record<string, any>): Promise<void> {
    const content = edu?.content;
    if (!isObject(content)) return;
    switch (edu.edu_type) {
      case M.TYPING: {
        const { room_id, user_id, typing } = content;
        if (typeof user_id !== "string" || domainOf(user_id) !== origin || typeof room_id !== "string") return;
        if (!(await this.hs.rooms.exists(room_id)) || !(await this.mayActInRoom(room_id, user_id, origin))) return;
        if (!serverAllowedByAcl(await this.hs.rooms.currentState(room_id), origin)) return;
        await this.hs.typing.setTyping(room_id, user_id, !!typing, typeof content.timeout === "number" ? content.timeout : 30_000);
        return;
      }
      case M.RECEIPT: {
        for (const [roomId, byType] of Object.entries(content)) {
          if (!isObject(byType) || !(await this.hs.rooms.exists(roomId))) continue;
          if (!serverAllowedByAcl(await this.hs.rooms.currentState(roomId), origin)) continue;
          for (const [receiptType, byUser] of Object.entries(byType)) {
            if ((receiptType !== M.READ._ && receiptType !== M.READ.PRIVATE) || !isObject(byUser)) continue;
            for (const [userId, r] of Object.entries(byUser)) {
              if (domainOf(userId) !== origin || !isObject(r) || !Array.isArray(r.event_ids)) continue;
              if (!(await this.mayActInRoom(roomId, userId, origin))) continue;
              const eventId = r.event_ids[r.event_ids.length - 1];
              if (typeof eventId !== "string") continue;
              await this.hs.streams.write((stream) =>
                this.hs.db.upsert("receipts", {
                  room_id: roomId,
                  user_id: userId,
                  receipt_type: receiptType,
                  thread_id: typeof r.data?.thread_id === "string" ? r.data.thread_id : "",
                  event_id: eventId,
                  ts: Number(r.data?.ts) || Date.now(),
                  stream,
                }),
              );
            }
          }
          this.hs.notifier.notify(await this.hs.rooms.joinedMembers(roomId));
        }
        return;
      }
      case M.PRESENCE: {
        for (const p of Array.isArray(content.push) ? content.push : []) {
          if (!isObject(p) || typeof p.user_id !== "string" || domainOf(p.user_id) !== origin) continue;
          if (!["online", "offline", "unavailable"].includes(p.presence)) continue;
          await this.hs.streams.write((stream) =>
            this.hs.db.upsert("presence", {
              user_id: p.user_id,
              presence: p.presence,
              status_msg: typeof p.status_msg === "string" ? p.status_msg : null,
              last_active_ts: Date.now() - (Number(p.last_active_ago) || 0),
              stream,
            }),
          );
          this.hs.notifier.notify(await this.hs.rooms.usersSharingRooms(p.user_id));
        }
        return;
      }
      case M.DEVICE_LIST_UPDATE: {
        const userId = content.user_id;
        if (typeof userId !== "string" || domainOf(userId) !== origin || typeof content.device_id !== "string") return;
        // An announcement for a user we have never tracked that carries no keys (e.g. sent when they
        // joined a room, which already reported them as changed) is not a new change for clients.
        const known = await this.hs.db.findOne("remote_device_lists", [{ field: "user_id", value: userId }]);
        if (!(await this.hs.keys.isTracked(userId))) await this.hs.partialState.notePendingDeviceUpdate(userId, origin);
        // Users sharing a room with us have a cached device list: refetch it on the next query.
        await this.hs.keys.markRemoteStale(userId);
        if (known || content.deleted || isObject(content.keys)) await this.hs.keys.markDeviceListChanged(userId);
        return;
      }
      case M.SIGNING_KEY_UPDATE: {
        const userId = content.user_id;
        if (typeof userId !== "string" || domainOf(userId) !== origin) return;
        for (const type of ["master", "self_signing"]) {
          const key = content[`${type}_key`];
          if (isObject(key))
            await this.hs.streams.write((stream) =>
              this.hs.db.upsert("cross_signing_keys", { user_id: userId, key_type: type, key, stream }),
            );
        }
        await this.hs.keys.markRemoteStale(userId);
        await this.hs.keys.markDeviceListChanged(userId);
        return;
      }
      case M.DIRECT_TO_DEVICE: {
        const { sender, type, message_id, messages } = content;
        if (typeof sender !== "string" || domainOf(sender) !== origin || typeof type !== "string" || !isObject(messages)) return;
        if (!(await this.hs.cluster.setIfAbsent(`fedtodevice:${origin}|${message_id}`, true, 24 * 3600_000))) return;
        const recipients = new Set<string>();
        for (const [userId, devices] of Object.entries(messages)) {
          if (!this.hs.isLocalUser(userId) || !isObject(devices)) continue;
          let targets = Object.keys(devices);
          if (targets.includes("*"))
            targets = (await this.hs.db.findMany("devices", { where: [{ field: "user_id", value: userId }] })).map((d) => d.device_id);
          for (const deviceId of targets) {
            await this.hs.streams.write((stream) =>
              this.hs.db.create("to_device", {
                stream,
                user_id: userId,
                device_id: deviceId,
                sender,
                type,
                content: devices[deviceId] ?? devices["*"],
              }),
            );
          }
          recipients.add(userId);
        }
        this.hs.notifier.notify(recipients);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Membership over federation
  // ---------------------------------------------------------------------------

  /** Build a full event from a make_join/make_leave/make_knock template and sign it. */
  private finaliseTemplate(template: Record<string, any>, version: string, extraContent: Record<string, any>): PDU {
    const { event_id, hashes, signatures, unsigned, ...rest } = template;
    const pdu = { ...rest, content: { ...rest.content, ...extraContent }, origin_server_ts: Date.now() } as PDU;
    if (roomVersionFeatures(version).legacyEventIds) pdu.origin = this.hs.serverName;
    return finalisePdu(pdu, version, this.hs.serverName, this.hs.signingKey);
  }

  /** Join a room hosted on other servers. Returns the room ID. */
  async joinRemoteRoom(userId: string, roomId: string, servers: string[], content: Record<string, any>): Promise<string> {
    this.requireEnabled();
    let lastError: unknown = errors.notFound("No server could be reached to join the room");
    for (const server of [...new Set(servers)].filter((s) => s !== this.hs.serverName && this.serverAllowed(s))) {
      try {
        const tmpl = await this.client.request(
          server,
          "GET",
          `/_matrix/federation/v1/make_join/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`,
          {
            query: { ver: SUPPORTED_ROOM_VERSIONS },
          },
        );
        const version = typeof tmpl.room_version === "string" ? tmpl.room_version : "1";
        if (!SUPPORTED_ROOM_VERSIONS.includes(version)) throw errors.unsupportedRoomVersion();
        if (
          !isObject(tmpl.event) ||
          tmpl.event.content?.membership !== "join" ||
          tmpl.event.state_key !== userId ||
          tmpl.event.sender !== userId
        ) {
          throw errors.badJson("Invalid make_join template");
        }
        const joinPdu = this.finaliseTemplate(tmpl.event, version, content);
        // MSC3902: ask for partial state (no membership events) so the join completes quickly;
        // the full state is fetched in the background afterwards.
        const res = await this.client.request(
          server,
          "PUT",
          `/_matrix/federation/v2/send_join/${encodeURIComponent(roomId)}/${encodeURIComponent(joinPdu.event_id!)}`,
          {
            body: this.toFederationPdu(joinPdu, version),
            query: this.fasterJoins ? { omit_members: "true" } : undefined,
            timeoutMs: 120_000,
          },
        );
        // Restricted joins come back with the authorising server's signature.
        if (isObject(res.event?.signatures)) joinPdu.signatures = { ...joinPdu.signatures, ...res.event.signatures };
        await this.completeJoin(roomId, version, joinPdu, res, server);
        return roomId;
      } catch (err) {
        lastError = err;
        this.hs.logger.debug("Joining", roomId, "via", server, "failed", err);
      }
    }
    throw lastError;
  }

  private async completeJoin(roomId: string, version: string, joinPdu: PDU, res: Record<string, any>, origin: string): Promise<void> {
    const statePdus: any[] = Array.isArray(res.state) ? res.state : [];
    const authChain: any[] = Array.isArray(res.auth_chain) ? res.auth_chain : [];
    await this.storeOutliers(roomId, version, [...authChain, ...statePdus]);
    const stateIds: Record<string, string> = {};
    let create: PDU | undefined;
    for (const raw of statePdus) {
      if (!isObject(raw) || typeof raw.state_key !== "string") continue;
      const id = this.computeEventId(raw, version);
      const pdu = await this.hs.rooms.getPdu(id);
      if (!pdu) continue;
      stateIds[stateKey(pdu.type, pdu.state_key!)] = id;
      if (pdu.type === M.ROOM.CREATE) create = pdu;
    }
    if (!create) throw errors.badJson("send_join response lacks the create event");
    if (!(await this.hs.rooms.exists(roomId))) {
      await this.hs.db.upsert("rooms", {
        room_id: roomId,
        room_version: version,
        creator: create.sender,
        is_public: false,
        created_ts: Date.now(),
      });
    }
    // Already participating (a join authorised by another server): the join fits our DAG as is.
    if (await this.hs.rooms.serverIsJoined(roomId)) {
      await this.hs.rooms.withLock(roomId, () => this.hs.rooms.persistEvent(roomId, version, joinPdu, { local: true, noFederate: true }));
      return;
    }
    // History before the join (or since we last left) has to be backfilled on demand, unless we
    // already hold the join's predecessors.
    let gap = false;
    for (const prev of (joinPdu.prev_events ?? []).map(eventIdOf)) if (!(await this.hs.rooms.getEvent(prev))) gap = true;
    await this.hs.rooms.withLock(roomId, () =>
      this.hs.rooms.persistEvent(roomId, version, joinPdu, {
        local: true,
        stateBefore: stateIds,
        createEvent: roomVersionFeatures(version).v12 ? create : undefined,
        noFederate: true,
        gap,
      }),
    );
    if (res.members_omitted === true) {
      const servers = Array.isArray(res.servers_in_room)
        ? res.servers_in_room.filter((s: unknown): s is string => typeof s === "string")
        : [];
      await this.hs.partialState.markPartial(roomId, joinPdu.event_id!, origin, servers);
    }
  }

  /** Leave (or reject an invite to) a room hosted elsewhere. */
  async leaveRemoteRoom(userId: string, roomId: string, servers: string[], reason?: string): Promise<PDU> {
    this.requireEnabled();
    let lastError: unknown = errors.notFound("No server could be reached to leave the room");
    for (const server of [...new Set(servers)].filter((s) => s !== this.hs.serverName)) {
      try {
        const tmpl = await this.client.request(
          server,
          "GET",
          `/_matrix/federation/v1/make_leave/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`,
        );
        const version = typeof tmpl.room_version === "string" ? tmpl.room_version : "1";
        const pdu = this.finaliseTemplate(tmpl.event, version, reason ? { reason } : {});
        await this.client.request(
          server,
          "PUT",
          `/_matrix/federation/v2/send_leave/${encodeURIComponent(roomId)}/${encodeURIComponent(pdu.event_id!)}`,
          {
            body: this.toFederationPdu(pdu, version),
          },
        );
        return pdu;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  async knockRemoteRoom(userId: string, roomId: string, servers: string[], reason?: string): Promise<{ pdu: PDU; knockState: any[] }> {
    this.requireEnabled();
    let lastError: unknown = errors.notFound("No server could be reached to knock on the room");
    for (const server of [...new Set(servers)].filter((s) => s !== this.hs.serverName)) {
      try {
        const tmpl = await this.client.request(
          server,
          "GET",
          `/_matrix/federation/v1/make_knock/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`,
          {
            query: { ver: SUPPORTED_ROOM_VERSIONS },
          },
        );
        const version = typeof tmpl.room_version === "string" ? tmpl.room_version : "1";
        const pdu = this.finaliseTemplate(tmpl.event, version, reason ? { reason } : {});
        const res = await this.client.request(
          server,
          "PUT",
          `/_matrix/federation/v1/send_knock/${encodeURIComponent(roomId)}/${encodeURIComponent(pdu.event_id!)}`,
          {
            body: this.toFederationPdu(pdu, version),
          },
        );
        return { pdu, knockState: Array.isArray(res.knock_room_state) ? res.knock_room_state : [] };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  /** Ask the invitee's server to sign an invite; returns the countersigned event. */
  async sendInvite(pdu: PDU, version: string, inviteRoomState: Record<string, any>[]): Promise<PDU> {
    this.requireEnabled();
    const server = domainOf(pdu.state_key!);
    if (!this.serverAllowed(server)) throw errors.forbidden("Federation with this server is not allowed");
    const res = await this.client.request(
      server,
      "PUT",
      `/_matrix/federation/v2/invite/${encodeURIComponent(pdu.room_id)}/${encodeURIComponent(pdu.event_id!)}`,
      {
        body: { room_version: version, event: this.toFederationPdu(pdu, version), invite_room_state: inviteRoomState },
      },
    );
    if (!isObject(res.event)) throw errors.unknown("Invalid invite response");
    const signed = { ...pdu, signatures: { ...pdu.signatures, ...res.event.signatures } };
    // Signatures cover the wire format (no event_id for v3+), redacted.
    if (!(await this.keyring.verifySignedBy(redact(this.toFederationPdu(signed, version), version), server))) {
      throw errors.forbidden("Invite was not signed by the invitee's server");
    }
    return signed;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async queryProfile(userId: string, field?: string): Promise<Record<string, any>> {
    this.requireEnabled();
    return this.client.request(domainOf(userId), "GET", "/_matrix/federation/v1/query/profile", { query: { user_id: userId, field } });
  }

  async queryAlias(alias: string): Promise<{ room_id: string; servers: string[] }> {
    this.requireEnabled();
    return this.client.request(domainOf(alias), "GET", "/_matrix/federation/v1/query/directory", { query: { room_alias: alias } });
  }

  async queryKeys(
    deviceKeys: Record<string, string[]>,
    timeoutMs = 10_000,
  ): Promise<{ results: Record<string, any>[]; failures: Record<string, any> }> {
    const byServer = new Map<string, Record<string, string[]>>();
    for (const [userId, devices] of Object.entries(deviceKeys)) {
      const server = domainOf(userId);
      if (server === this.hs.serverName) continue;
      (byServer.get(server) ?? byServer.set(server, {}).get(server)!)[userId] = devices;
    }
    const results: Record<string, any>[] = [];
    const failures: Record<string, any> = {};
    await Promise.all(
      [...byServer].map(async ([server, query]) => {
        try {
          if (!this.enabled || !this.serverAllowed(server)) throw new Error("Federation disabled");
          results.push(
            await this.client.request(server, "POST", "/_matrix/federation/v1/user/keys/query", {
              body: { device_keys: query },
              timeoutMs,
            }),
          );
        } catch (err) {
          failures[server] = { status: 503, message: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return { results, failures };
  }

  async claimKeys(
    oneTimeKeys: Record<string, Record<string, string>>,
    timeoutMs = 10_000,
  ): Promise<{ results: Record<string, any>; failures: Record<string, any> }> {
    const byServer = new Map<string, Record<string, Record<string, string>>>();
    for (const [userId, devices] of Object.entries(oneTimeKeys)) {
      const server = domainOf(userId);
      if (server === this.hs.serverName) continue;
      (byServer.get(server) ?? byServer.set(server, {}).get(server)!)[userId] = devices;
    }
    const results: Record<string, any> = {};
    const failures: Record<string, any> = {};
    await Promise.all(
      [...byServer].map(async ([server, query]) => {
        try {
          if (!this.enabled) throw new Error("Federation disabled");
          const res = await this.client.request(server, "POST", "/_matrix/federation/v1/user/keys/claim", {
            body: { one_time_keys: query },
            timeoutMs,
          });
          Object.assign(results, res.one_time_keys ?? {});
        } catch (err) {
          failures[server] = { status: 503, message: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return { results, failures };
  }

  async queryPublicRooms(server: string, body: Record<string, any>): Promise<Record<string, any>> {
    this.requireEnabled();
    return this.client.request(server, "POST", "/_matrix/federation/v1/publicRooms", { body });
  }

  async queryHierarchy(server: string, roomId: string, suggestedOnly: boolean): Promise<Record<string, any>> {
    this.requireEnabled();
    return this.client.request(server, "GET", `/_matrix/federation/v1/hierarchy/${encodeURIComponent(roomId)}`, {
      query: { suggested_only: String(suggestedOnly) },
    });
  }

  // ---------------------------------------------------------------------------
  // Backfill
  // ---------------------------------------------------------------------------

  /**
   * Fetch history preceding the oldest events we have. Returns the number of new
   * events stored. Caller should not hold the room lock.
   */
  async backfill(roomId: string, fromEventIds: string[], limit = 50): Promise<number> {
    if (!this.enabled || !fromEventIds.length) return 0;
    const version = await this.hs.rooms.roomVersion(roomId);
    if (!version) return 0;
    const servers = [...this.serversInRoom(await this.hs.rooms.currentState(roomId))];
    for (const server of servers) {
      try {
        const res = await this.client.request(server, "GET", `/_matrix/federation/v1/backfill/${encodeURIComponent(roomId)}`, {
          query: { v: fromEventIds, limit: String(limit) },
        });
        const verified: PDU[] = [];
        for (const raw of Array.isArray(res.pdus) ? res.pdus : []) {
          try {
            const { pdu } = await this.verifyPdu(raw, version, roomId);
            if (!(await this.hs.rooms.getEvent(pdu.event_id!))) verified.push(pdu);
          } catch {
            /* skip invalid */
          }
        }
        if (!verified.length) return 0;
        // Allocate positions newest-first so that older events sort earlier, then persist oldest-first.
        verified.sort((a, b) => b.depth - a.depth);
        const positions = new Map<string, number>();
        for (const p of verified) positions.set(p.event_id!, await this.hs.streams.backfillId());
        verified.reverse();
        let stored = 0;
        await this.hs.rooms.withLock(roomId, async () => {
          for (const pdu of verified) {
            try {
              await this.fetchMissingAuthEvents(server, roomId, version, pdu);
              let stateBefore: Record<string, string> | undefined;
              const prevIds = (pdu.prev_events ?? []).map(eventIdOf);
              const unknown = [];
              for (const id of prevIds) if ((await this.hs.rooms.snapshotOf(id)) === null) unknown.push(id);
              if (unknown.length) stateBefore = await this.fetchStateBefore(server, roomId, version, pdu.event_id!);
              const r = await this.hs.rooms.persistEvent(roomId, version, pdu, {
                backfill: true,
                stateBefore,
                stream: positions.get(pdu.event_id!),
              });
              if (r.status === "persisted") stored++;
            } catch (err) {
              this.hs.logger.debug("Backfilled event failed", pdu.event_id, err);
            }
          }
        });
        return stored;
      } catch (err) {
        this.hs.logger.debug("Backfill from", server, "failed", err);
      }
    }
    return 0;
  }

  // ---------------------------------------------------------------------------
  // Remote media
  // ---------------------------------------------------------------------------

  /** Download remote media (authenticated federation endpoint, falling back to the legacy one). */
  async fetchMedia(server: string, mediaId: string): Promise<{ data: Uint8Array; contentType: string | null; filename: string | null }> {
    this.requireEnabled();
    const res = await this.client.requestRaw(server, "GET", `/_matrix/federation/v1/media/download/${encodeURIComponent(mediaId)}`, {
      timeoutMs: 60_000,
    });
    if (res.status === 200) {
      const ct = String(res.headers["content-type"] ?? "");
      const m = /boundary=("?)([^";]+)\1/.exec(ct);
      if (ct.startsWith("multipart/") && m) return parseMultipartMedia(res.body, m[2], this);
    }
    const legacy = await this.client.requestRaw(
      server,
      "GET",
      `/_matrix/media/v3/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`,
      {
        query: { allow_remote: "false" },
        signed: false,
        timeoutMs: 60_000,
      },
    );
    if (legacy.status !== 200) throw errors.notFound("Remote media not found");
    return {
      data: legacy.body,
      contentType: (legacy.headers["content-type"] as string) ?? null,
      filename: filenameFromDisposition(legacy.headers["content-disposition"] as string),
    };
  }

  /** Remote members who should receive the invitee's stripped state. */
  strippedStateFor(state: StateMap): Record<string, any>[] {
    return this.hs.rooms.strippedState(state);
  }

  /** Servers that may be able to help us join `roomId`. */
  candidateServers(roomId: string, extra: string[] = []): string[] {
    const fromId = parseId(roomId, "!")?.server;
    return [...new Set([...extra, ...(fromId ? [fromId] : [])])];
  }

  static memberServers(state: StateMap): string[] {
    const out = new Set<string>();
    for (const [key, ev] of state) {
      const [type, userId] = splitStateKey(key);
      if (type === M.ROOM.MEMBER && ev.content?.membership === "join") out.add(domainOf(userId));
    }
    return [...out];
  }

  isMembershipVisibleTo(state: StateMap, server: string): boolean {
    for (const [key] of state) {
      const [type, userId] = splitStateKey(key);
      if (type === M.ROOM.MEMBER && domainOf(userId) === server && membershipOf(state, userId) === "join") return true;
    }
    return false;
  }

  stripped(pdu: PDU): Record<string, any> {
    return stripState(pdu);
  }

  error(status: number, errcode: string, message: string): MatrixError {
    return new MatrixError(status, errcode, message);
  }
}

function filenameFromDisposition(header: string | undefined): string | null {
  if (!header) return null;
  const star = /filename\*=utf-8''([^;]+)/i.exec(header);
  if (star) return decodeURIComponent(star[1]);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : null;
}

/** Parse a federation media multipart/mixed response: a JSON part then the file (or a redirect). */
async function parseMultipartMedia(
  body: Buffer,
  boundary: string,
  fed: FederationService,
): Promise<{ data: Uint8Array; contentType: string | null; filename: string | null }> {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let idx = body.indexOf(delimiter);
  while (idx !== -1) {
    const next = body.indexOf(delimiter, idx + delimiter.length);
    if (next === -1) break;
    parts.push(body.subarray(idx + delimiter.length, next));
    idx = next;
  }
  const media = parts[1];
  if (!media) throw errors.notFound("Malformed media response");
  const headerEnd = media.indexOf("\r\n\r\n");
  const headerText = media.subarray(0, headerEnd).toString("utf8");
  const data = media.subarray(headerEnd + 4, media.length - 2);
  const headers: Record<string, string> = {};
  for (const line of headerText.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  if (headers.location) {
    const res = await fetch(headers.location, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw errors.notFound("Remote media redirect failed");
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type"),
      filename: filenameFromDisposition(res.headers.get("content-disposition") ?? undefined),
    };
  }
  void fed;
  return {
    data: new Uint8Array(data),
    contentType: headers["content-type"] ?? null,
    filename: filenameFromDisposition(headers["content-disposition"]),
  };
}
