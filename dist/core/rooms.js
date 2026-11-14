import { isObject, stringOrUndefined } from "../packages/shared/src/json.js";
import { isValidUserId } from "../packages/shared/src/ids.js";
import { M } from "../packages/shared/src/m.js";
import { CLUSTER_RESYNC } from "./cluster.js";
import { MatrixError, errors } from "./errors.js";
import { eventIdOf, finalisePdu, redactPdu, roomVersionFeatures, splitStateKey, stateKey, toClientEvent } from "./events.js";
import { authEventKeys, authStateFromAuthEvents, checkAuth, getState, membershipOf, powerLevels, userLevel } from "./authrules.js";
import { resolveState } from "./stateres.js";
import { generateRoomId } from "./ids.js";
import { copyRoomPushRules } from "./pushrules.js";
import { initialPowerLevels, parseCreateRoom } from "./createroom.js";
// src/core/rooms.ts
const PARTIAL_REJECTION = "Partial state: ";
/** Thrown when the state before an event cannot be computed because predecessors are unknown. */
var MissingStateError = class extends Error {
	eventIds;
	constructor(eventIds) {
		super(`Missing state for ${eventIds.join(", ")}`);
		this.eventIds = eventIds;
	}
};
var LruCache = class {
	map = /* @__PURE__ */ new Map();
	max;
	constructor(max) {
		this.max = max;
	}
	get(k) {
		const v = this.map.get(k);
		if (v !== void 0) {
			this.map.delete(k);
			this.map.set(k, v);
		}
		return v;
	}
	set(k, v) {
		this.map.delete(k);
		this.map.set(k, v);
		if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
	}
	clear() {
		this.map.clear();
	}
	delete(k) {
		this.map.delete(k);
	}
};
const MAX_EVENT_SIZE = 65536;
/** A full state snapshot is written after this many deltas. */
const SNAPSHOT_INTERVAL = 64;
/** Reject malformed power level content with 400 before it reaches the auth rules. */
function validatePowerLevelContent(content, creators) {
	const check = (v) => {
		if (typeof v === "number" && Math.abs(v) > Number.MAX_SAFE_INTEGER) throw errors.badJson("Power level out of range");
	};
	for (const v of Object.values(content)) if (isObject(v)) Object.values(v).forEach(check);
	else check(v);
	if (isObject(content.users)) {
		for (const u of Object.keys(content.users)) if (creators.has(u)) throw errors.badJson("Room creators cannot be given a power level");
	}
}
const txnTokenOf = (userId, deviceId) => `${userId}|${deviceId}`;
var RoomService = class {
	hs;
	eventCache = new LruCache(2e4);
	snapshotCache = new LruCache(2e3);
	stateCache = /* @__PURE__ */ new Map();
	extremityCache = /* @__PURE__ */ new Map();
	outlierCache = new LruCache(5e3);
	versions = /* @__PURE__ */ new Map();
	snapshotDepths = new LruCache(2e4);
	sharingCache = /* @__PURE__ */ new Map();
	localClusterMarker;
	constructor(hs, singleInstance) {
		this.hs = hs;
		this.localClusterMarker = singleInstance ? hs.cluster : null;
		hs.cluster.subscribe("invalidate", (msg) => {
			if (msg?.from !== hs.instanceId) this.invalidateLocal(msg);
		});
		hs.cluster.subscribe(CLUSTER_RESYNC, () => {
			for (const c of [
				this.stateCache,
				this.extremityCache,
				this.sharingCache,
				this.eventCache,
				this.outlierCache
			]) c.clear();
		});
	}
	/** Serialise writes per room (cluster-wide) so forward extremities stay consistent. */
	async withLock(roomId, fn) {
		return this.hs.cluster.lock(`room:${roomId}`, async () => {
			if (this.hs.cluster !== this.localClusterMarker) this.invalidateLocal({ rooms: [roomId] });
			return fn();
		});
	}
	/** Drop cached data (for this instance only). */
	invalidateLocal(msg) {
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
	invalidate(msg) {
		this.hs.cluster.publish("invalidate", {
			...msg,
			from: this.hs.instanceId
		}).catch((err) => this.hs.logger.warn("Cluster cache invalidation failed; other instances may serve stale state", err));
	}
	forgetEventCache(eventId) {
		this.eventCache.delete(eventId);
	}
	/** Drop all cached data for a room (after it was purged). */
	forgetRoom(roomId) {
		this.versions.delete(roomId);
		this.extremityCache.delete(roomId);
		this.stateCache.delete(roomId);
		this.sharingCache.clear();
	}
	async roomVersion(roomId) {
		const cached = this.versions.get(roomId);
		if (cached) return cached;
		const room = await this.hs.db.findOne("rooms", [{
			field: "room_id",
			value: roomId
		}]);
		if (!room) return null;
		this.versions.set(roomId, room.room_version);
		return room.room_version;
	}
	async exists(roomId) {
		return await this.roomVersion(roomId) !== null;
	}
	rowToStored(row) {
		return {
			pdu: row.json.room_id ? row.json : {
				...row.json,
				room_id: row.room_id
			},
			stream: row.stream,
			snapshot: row.state_snapshot,
			txnId: row.txn_id,
			txnToken: row.txn_token,
			gap: !!row.gap
		};
	}
	async getEvent(eventId) {
		const cached = this.eventCache.get(eventId);
		if (cached) return cached;
		const row = await this.hs.db.findOne("events", [{
			field: "event_id",
			value: eventId
		}]);
		if (!row) return null;
		const stored = this.rowToStored(row);
		this.eventCache.set(eventId, stored);
		return stored;
	}
	async getEvents(eventIds) {
		const out = /* @__PURE__ */ new Map();
		const missing = [];
		for (const id of eventIds) {
			const c = this.eventCache.get(id);
			if (c) out.set(id, c);
			else missing.push(id);
		}
		for (let i = 0; i < missing.length; i += 500) {
			const rows = await this.hs.db.findMany("events", { where: [{
				field: "event_id",
				operator: "in",
				value: missing.slice(i, i + 500)
			}] });
			for (const row of rows) {
				const stored = this.rowToStored(row);
				this.eventCache.set(row.event_id, stored);
				out.set(row.event_id, stored);
			}
		}
		return out;
	}
	async snapshotIds(snapshotId) {
		if (snapshotId === 0) return {};
		const cached = this.snapshotCache.get(snapshotId);
		if (cached) return cached;
		const row = await this.hs.db.findOne("state_snapshots", [{
			field: "id",
			value: snapshotId
		}]);
		const delta = row?.state ?? {};
		const state = row?.prev ? {
			...await this.snapshotIds(row.prev),
			...delta
		} : delta;
		this.snapshotCache.set(snapshotId, state);
		this.snapshotDepths.set(snapshotId, row?.depth ?? 0);
		return state;
	}
	async stateAtSnapshot(snapshotId) {
		return this.stateIdsToMap(await this.snapshotIds(snapshotId));
	}
	async currentState(roomId) {
		const cached = this.stateCache.get(roomId);
		if (cached) return cached;
		const rows = await this.hs.db.findMany("current_state", { where: [{
			field: "room_id",
			value: roomId
		}] });
		const events = await this.getPdus(rows.map((r) => r.event_id));
		const state = /* @__PURE__ */ new Map();
		for (const r of rows) {
			const ev = events.get(r.event_id);
			if (ev) state.set(stateKey(r.type, r.state_key), ev);
		}
		this.stateCache.set(roomId, state);
		return state;
	}
	async currentStateIds(roomId) {
		const ids = {};
		for (const [k, ev] of await this.currentState(roomId)) ids[k] = ev.event_id;
		return ids;
	}
	/** Forward extremities: the latest events in the room DAG, used as prev_events of new events. */
	async extremities(roomId) {
		const cached = this.extremityCache.get(roomId);
		if (cached) return cached;
		const ids = (await this.hs.db.findMany("forward_extremities", { where: [{
			field: "room_id",
			value: roomId
		}] })).map((r) => r.event_id);
		this.extremityCache.set(roomId, ids);
		return ids;
	}
	async getOutlier(eventId) {
		const cached = this.outlierCache.get(eventId);
		if (cached) return cached;
		const row = await this.hs.db.findOne("outliers", [{
			field: "event_id",
			value: eventId
		}]);
		if (!row) return null;
		const outlier = {
			pdu: row.json.room_id ? row.json : {
				...row.json,
				room_id: row.room_id
			},
			snapshot: row.state_snapshot,
			rejected: row.rejected,
			softFailed: !!row.soft_failed
		};
		this.outlierCache.set(eventId, outlier);
		return outlier;
	}
	/** Any known PDU (timeline event or non-rejected outlier). */
	async getPdu(eventId) {
		const ev = await this.getEvent(eventId);
		if (ev) return ev.pdu;
		const o = await this.getOutlier(eventId);
		return o && !o.rejected ? o.pdu : null;
	}
	async getPdus(eventIds) {
		const out = /* @__PURE__ */ new Map();
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
	async knowsEvent(eventId) {
		return !!await this.getEvent(eventId) || !!await this.getOutlier(eventId);
	}
	/** Snapshot ID of the state after an event, or null when the state is unknown. */
	async snapshotOf(eventId) {
		const ev = await this.getEvent(eventId);
		if (ev) return ev.snapshot;
		const o = await this.getOutlier(eventId);
		return o && !o.rejected && o.snapshot !== null ? o.snapshot : null;
	}
	async stateIdsToMap(ids) {
		const events = await this.getPdus(Object.values(ids));
		const state = /* @__PURE__ */ new Map();
		for (const [k, id] of Object.entries(ids)) {
			const ev = events.get(id);
			if (ev) state.set(k, ev);
		}
		return state;
	}
	async createEventOf(roomId) {
		return getState(await this.currentState(roomId), M.ROOM.CREATE);
	}
	/**
	* State before an event with the given prev_events: the snapshot of a single
	* predecessor, or the resolution of several. Throws MissingStateError when a
	* predecessor's state is unknown.
	*/
	async stateBefore(roomId, version, prevIds, createEvent) {
		if (prevIds.length === 0) return {
			ids: {},
			snapshot: 0
		};
		const snapshots = [];
		const missing = [];
		const queue = [...prevIds];
		const visited = /* @__PURE__ */ new Set();
		while (queue.length) {
			const id = queue.shift();
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
		if (unique.length === 1) return {
			ids: await this.snapshotIds(unique[0]),
			snapshot: unique[0]
		};
		const sets = await Promise.all(unique.map((s) => this.snapshotIds(s)));
		return {
			ids: await resolveState(sets, version, (eids) => this.getPdus(eids), createEvent ?? (version && roomVersionFeatures(version).v12 ? await this.createEventOf(roomId) : void 0)),
			snapshot: null
		};
	}
	/** Validate, authorise, sign and persist a new local event. Returns the event ID. */
	async sendEvent(roomId, sender, draft, opts = {}) {
		return this.withLock(roomId, async () => {
			if (opts.txnId && opts.deviceId) {
				const token = txnTokenOf(sender, opts.deviceId);
				const existing = await this.hs.db.findOne("events", [{
					field: "txn_id",
					value: opts.txnId
				}, {
					field: "txn_token",
					value: token
				}]);
				if (existing && existing.room_id === roomId) return existing.event_id;
			}
			const version = await this.roomVersion(roomId);
			if (!version) throw errors.notFound("Unknown room");
			const pdu = await this.buildLocalEvent(roomId, version, sender, draft, opts.skipAuth, opts.ts);
			return (await this.persistEvent(roomId, version, pdu, {
				local: true,
				txnId: opts.txnId,
				deviceId: opts.deviceId
			})).eventId;
		});
	}
	/** Build and sign (but do not persist) a local event on top of the current forward extremities. */
	async buildLocalEvent(roomId, version, sender, draft, skipAuth = false, ts) {
		const features = roomVersionFeatures(version);
		const extremities = await this.extremities(roomId);
		const prevs = [...(await this.getPdus(extremities)).values()].sort((a, b) => b.depth - a.depth).slice(0, 10);
		const prevIds = prevs.map((p) => p.event_id);
		const before = prevIds.length === extremities.length ? await this.currentState(roomId) : await this.stateIdsToMap((await this.stateBefore(roomId, version, prevIds)).ids);
		const authEvents = authEventKeys({
			...draft,
			sender
		}, version).map((k) => before.get(k)?.event_id).filter((x) => !!x);
		const depth = Math.min(prevs.reduce((m, p) => Math.max(m, p.depth), 0) + 1, Number.MAX_SAFE_INTEGER);
		const pdu = {
			room_id: roomId,
			sender,
			type: draft.type,
			content: draft.content,
			origin_server_ts: ts ?? Date.now(),
			depth,
			prev_events: prevIds,
			auth_events: authEvents
		};
		if (draft.state_key !== void 0) pdu.state_key = draft.state_key;
		if (draft.redacts !== void 0) {
			if (features.v11) pdu.content = {
				...pdu.content,
				redacts: draft.redacts
			};
			else pdu.redacts = draft.redacts;
		}
		if (features.legacyEventIds) {
			pdu.prev_events = pdu.prev_events.map((id) => [eventIdOf(id), {}]);
			pdu.auth_events = pdu.auth_events.map((id) => [eventIdOf(id), {}]);
		}
		if (!skipAuth) {
			if (features.v12) before.set(stateKey(M.ROOM.CREATE, ""), await this.createEventOf(roomId));
			checkAuth(pdu, before, version);
		}
		if (Buffer.byteLength(JSON.stringify(pdu)) > MAX_EVENT_SIZE) throw errors.tooLarge("Event too large");
		return finalisePdu(pdu, version, this.hs.serverName, this.hs.signingKey);
	}
	/**
	* Persist an event (local or remote). Remote events are checked against their auth
	* events, the state before them and the current state (soft failure).
	*/
	async persistEvent(roomId, version, pdu, opts = {}) {
		const features = roomVersionFeatures(version);
		const eventId = pdu.event_id;
		if (await this.getEvent(eventId)) return {
			eventId,
			status: "persisted"
		};
		const createEvent = features.v12 ? pdu.type === M.ROOM.CREATE ? void 0 : opts.createEvent ?? await this.createEventOf(roomId) ?? await this.findCreateEvent(roomId) : void 0;
		const prevIds = (pdu.prev_events ?? []).map(eventIdOf);
		if (!opts.local) {
			const reject = async (reason) => {
				await this.hs.db.upsert("outliers", {
					event_id: eventId,
					room_id: roomId,
					json: pdu,
					state_snapshot: null,
					rejected: reason,
					soft_failed: false
				});
				this.outlierCache.delete(eventId);
				return {
					eventId,
					status: "rejected",
					reason
				};
			};
			try {
				const authPdus = await this.getPdus((pdu.auth_events ?? []).map(eventIdOf));
				if (authPdus.size !== (pdu.auth_events ?? []).length) return reject("Missing auth events");
				const authState = authStateFromAuthEvents(pdu, [...authPdus.values()], version, createEvent);
				checkAuth(pdu, authState, version, { joinAuthorisedSignatureValid: opts.joinAuthorisedSignatureValid });
			} catch (err) {
				return reject(`Auth events: ${err.message}`);
			}
		}
		let before;
		if (opts.stateBefore) before = {
			ids: opts.stateBefore,
			snapshot: null
		};
		else before = await this.stateBefore(roomId, version, prevIds, createEvent);
		const beforeMap = await this.stateIdsToMap(before.ids);
		if (createEvent) beforeMap.set(stateKey(M.ROOM.CREATE, ""), createEvent);
		const partial = !opts.local && !opts.backfill && await this.hs.partialState.isPartial(roomId);
		if (partial) {
			const authPdus = await this.getPdus((pdu.auth_events ?? []).map(eventIdOf));
			const claimed = {};
			for (const a of authPdus.values()) if (a.state_key !== void 0) claimed[stateKey(a.type, a.state_key)] = a.event_id;
			const resolved = await resolveState([before.ids, claimed], version, (ids) => this.getPdus(ids), createEvent);
			for (const [key, ev] of await this.stateIdsToMap(resolved)) beforeMap.set(key, ev);
		}
		if (!opts.local) {
			const reject = async (reason) => {
				await this.hs.db.upsert("outliers", {
					event_id: eventId,
					room_id: roomId,
					json: pdu,
					state_snapshot: null,
					rejected: reason,
					soft_failed: false
				});
				this.outlierCache.delete(eventId);
				return {
					eventId,
					status: "rejected",
					reason
				};
			};
			try {
				checkAuth(pdu, beforeMap, version, { joinAuthorisedSignatureValid: opts.joinAuthorisedSignatureValid });
			} catch (err) {
				return reject(`${partial ? PARTIAL_REJECTION : ""}State before: ${err.message}`);
			}
			if (!opts.backfill && !opts.stateBefore && !partial) {
				const current = new Map(await this.currentState(roomId));
				if (createEvent) current.set(stateKey(M.ROOM.CREATE, ""), createEvent);
				const softFail = async () => {
					const ids = pdu.state_key !== void 0 ? {
						...before.ids,
						[stateKey(pdu.type, pdu.state_key)]: eventId
					} : before.ids;
					await this.hs.streams.write((snap) => this.hs.transaction(async (db) => {
						await db.create("state_snapshots", {
							id: snap,
							room_id: roomId,
							prev: null,
							depth: 0,
							state: ids
						});
						await db.upsert("outliers", {
							event_id: eventId,
							room_id: roomId,
							json: pdu,
							state_snapshot: snap,
							rejected: null,
							soft_failed: true
						});
					}));
					this.outlierCache.delete(eventId);
					return {
						eventId,
						status: "soft_failed"
					};
				};
				try {
					checkAuth(pdu, current, version, { joinAuthorisedSignatureValid: opts.joinAuthorisedSignatureValid });
				} catch {
					return softFail();
				}
				if (!await this.hs.policyServers.recommended(roomId, version, pdu)) return softFail();
			}
		}
		if (opts.local) await this.hs.policyServers.signLocal(roomId, version, pdu);
		return this.store(roomId, version, pdu, before, beforeMap, features, opts);
	}
	/**
	* Finish a partial-state join (MSC3902): `fullBefore` is the complete state before our join
	* event. Recompute the state of the join and of every event received since, re-checking each
	* remote event against its now complete state (events wrongly accepted become rejected), then
	* rebuild the room's current state. Caller holds the room lock.
	*/
	async completePartialState(roomId, version, joinEventId, fullBefore, notified) {
		const features = roomVersionFeatures(version);
		const join = await this.getEvent(joinEventId);
		if (!join) return [];
		const createEvent = features.v12 ? await this.findCreateEvent(roomId) : void 0;
		const writeSnapshot = (ids) => this.hs.streams.write(async (id) => {
			await this.hs.db.create("state_snapshots", {
				id,
				room_id: roomId,
				prev: null,
				depth: 0,
				state: ids
			});
			this.snapshotCache.set(id, ids);
			this.snapshotDepths.set(id, 0);
			return id;
		});
		const setSnapshot = async (eventId, snapshot) => {
			await this.hs.db.update("events", [{
				field: "event_id",
				value: eventId
			}], { state_snapshot: snapshot });
			this.eventCache.delete(eventId);
		};
		const joinKey = stateKey(M.ROOM.MEMBER, join.pdu.state_key);
		await setSnapshot(joinEventId, await writeSnapshot({
			...fullBefore,
			[joinKey]: joinEventId
		}));
		const later = (await this.hs.db.findMany("events", {
			where: [{
				field: "room_id",
				value: roomId
			}, {
				field: "stream",
				operator: "gt",
				value: join.stream
			}],
			sortBy: {
				field: "stream",
				direction: "asc"
			}
		})).map((row) => ({
			pdu: this.rowToStored(row).pdu,
			stream: row.stream,
			rejected: false
		}));
		for (const row of await this.hs.db.findMany("outliers", { where: [{
			field: "room_id",
			value: roomId
		}] })) if (typeof row.rejected === "string" && row.rejected.startsWith(PARTIAL_REJECTION)) later.push({
			pdu: row.json.room_id ? row.json : {
				...row.json,
				room_id: roomId
			},
			stream: Number.MAX_SAFE_INTEGER,
			rejected: true
		});
		later.sort((a, b) => (a.pdu.depth ?? 0) - (b.pdu.depth ?? 0) || a.stream - b.stream);
		const touched = [joinEventId];
		const reinstated = [];
		const joinedServers = new Set(this.hs.federation.serversInRoom(await this.stateIdsToMap(fullBefore), false));
		for (const item of later) {
			const pdu = item.pdu;
			let before;
			try {
				before = await this.stateBefore(roomId, version, (pdu.prev_events ?? []).map(eventIdOf), createEvent);
			} catch {
				continue;
			}
			const beforeMap = await this.stateIdsToMap(before.ids);
			if (createEvent) beforeMap.set(stateKey(M.ROOM.CREATE, ""), createEvent);
			let allowed = true;
			let reason = "";
			if (!this.hs.isLocalUser(pdu.sender)) try {
				checkAuth(pdu, beforeMap, version, {});
			} catch (err) {
				allowed = false;
				reason = err.message;
			}
			if (item.rejected) {
				if (!allowed) continue;
				this.outlierCache.delete(pdu.event_id);
				await this.store(roomId, version, pdu, before, beforeMap, features, { noFederate: true });
				touched.push(pdu.event_id);
				reinstated.push(pdu.event_id);
				continue;
			}
			if (!allowed) {
				await this.hs.transaction(async (db) => {
					await db.delete("events", [{
						field: "event_id",
						value: pdu.event_id
					}]);
					await db.delete("relations", [{
						field: "event_id",
						value: pdu.event_id
					}]);
					await db.upsert("outliers", {
						event_id: pdu.event_id,
						room_id: roomId,
						json: pdu,
						state_snapshot: null,
						rejected: `State before: ${reason}`,
						soft_failed: false
					});
				});
				this.eventCache.delete(pdu.event_id);
				this.outlierCache.delete(pdu.event_id);
				touched.push(pdu.event_id);
				continue;
			}
			if (pdu.type === M.ROOM.MEMBER && pdu.content?.membership === "join") joinedServers.add(pdu.state_key.slice(pdu.state_key.indexOf(":") + 1));
			const isState = pdu.state_key !== void 0;
			const snapshot = !isState && before.snapshot !== null && before.snapshot !== 0 ? before.snapshot : await writeSnapshot(isState ? {
				...before.ids,
				[stateKey(pdu.type, pdu.state_key)]: pdu.event_id
			} : before.ids);
			await setSnapshot(pdu.event_id, snapshot);
			touched.push(pdu.event_id);
		}
		if (reinstated.length) {
			const referenced = new Set(later.filter((i) => !i.rejected).flatMap((i) => (i.pdu.prev_events ?? []).map(eventIdOf)));
			const stale = reinstated.filter((id) => referenced.has(id));
			if (stale.length) {
				for (const id of stale) await this.hs.db.delete("forward_extremities", [{
					field: "room_id",
					value: roomId
				}, {
					field: "event_id",
					value: id
				}]);
				this.extremityCache.delete(roomId);
			}
		}
		const rejected = /* @__PURE__ */ new Set();
		for (const id of touched) if ((await this.getOutlier(id))?.rejected) rejected.add(id);
		let extremities = await this.extremities(roomId);
		if (extremities.some((id) => rejected.has(id))) {
			const replacement = new Set(extremities.filter((id) => !rejected.has(id)));
			for (const id of extremities.filter((x) => rejected.has(x))) for (const prev of ((await this.getOutlier(id))?.pdu.prev_events ?? []).map(eventIdOf)) if (await this.getEvent(prev)) replacement.add(prev);
			extremities = [...replacement];
			await this.hs.transaction(async (db) => {
				await db.delete("forward_extremities", [{
					field: "room_id",
					value: roomId
				}]);
				for (const id of extremities) await db.upsert("forward_extremities", {
					room_id: roomId,
					event_id: id
				});
			});
			this.extremityCache.set(roomId, extremities);
		}
		const sets = [];
		for (const ext of extremities) {
			const snap = await this.snapshotOf(ext);
			if (snap !== null) sets.push(await this.snapshotIds(snap));
		}
		if (!sets.length) return [];
		const newIds = sets.length === 1 ? sets[0] : await resolveState(sets, version, (ids) => this.getPdus(ids), createEvent);
		const oldIds = await this.currentStateIds(roomId);
		const pdus = await this.getPdus(Object.values(newIds));
		await this.hs.streams.write((stream) => this.hs.transaction(async (db) => {
			for (const k of /* @__PURE__ */ new Set([...Object.keys(oldIds), ...Object.keys(newIds)])) {
				if (oldIds[k] === newIds[k]) continue;
				const [type, sk] = splitStateKey(k);
				const where = [
					{
						field: "room_id",
						value: roomId
					},
					{
						field: "type",
						value: type
					},
					{
						field: "state_key",
						value: sk
					}
				];
				if (!newIds[k]) {
					await db.delete("current_state", where);
					if (type === M.ROOM.MEMBER) await db.delete("memberships", [{
						field: "room_id",
						value: roomId
					}, {
						field: "user_id",
						value: sk
					}]);
					continue;
				}
				await db.upsert("current_state", {
					room_id: roomId,
					type,
					state_key: sk,
					event_id: newIds[k]
				});
				if (type === M.ROOM.MEMBER) await db.upsert("memberships", {
					room_id: roomId,
					user_id: sk,
					membership: pdus.get(newIds[k])?.content?.membership ?? "leave",
					event_id: newIds[k],
					stream,
					forgotten: false
				});
			}
		}));
		this.stateCache.delete(roomId);
		this.sharingCache.clear();
		this.invalidate({
			rooms: [roomId],
			events: touched,
			sharing: true
		});
		const changedMembers = /* @__PURE__ */ new Set();
		for (const k of /* @__PURE__ */ new Set([...Object.keys(oldIds), ...Object.keys(newIds)])) {
			const [type, userId] = splitStateKey(k);
			if (type === M.ROOM.MEMBER && oldIds[k] !== newIds[k] && this.hs.isLocalUser(userId)) changedMembers.add(userId);
		}
		if (changedMembers.size) this.hs.notifier.notify([...changedMembers, ...await this.interestedUsers(roomId)]);
		for (const k of Object.keys(oldIds)) {
			const [type, userId] = splitStateKey(k);
			if (type !== M.ROOM.MEMBER || this.hs.isLocalUser(userId) || oldIds[k] === newIds[k]) continue;
			if (!await this.hs.keys.isTracked(userId)) await this.hs.keys.dropRemoteCache(userId);
		}
		for (const s of this.hs.federation.serversInRoom(await this.currentState(roomId), false)) joinedServers.add(s);
		return [...joinedServers].filter((s) => s !== this.hs.serverName && !notified.has(s));
	}
	/** The create event, also when the room's current state is not known yet (v12 joins). */
	async findCreateEvent(roomId) {
		const id = `$${roomId.slice(1)}`;
		return await this.getPdu(id) ?? void 0;
	}
	async store(roomId, version, pdu, before, beforeMap, features, opts) {
		const eventId = pdu.event_id;
		const sender = pdu.sender;
		const backfill = !!opts.backfill;
		const lease = opts.stream !== void 0 || backfill ? null : await this.hs.streams.allocate();
		const stream = opts.stream ?? (backfill ? await this.hs.streams.backfillId() : lease.id);
		let wake = null;
		try {
			const isState = pdu.state_key !== void 0;
			const key = isState ? stateKey(pdu.type, pdu.state_key) : null;
			const prevState = key ? beforeMap.get(key) : void 0;
			const afterIds = key ? {
				...before.ids,
				[key]: eventId
			} : before.ids;
			let snapshot;
			let snapshotRow = null;
			if (!isState && before.snapshot !== null && before.snapshot !== 0) snapshot = before.snapshot;
			else {
				snapshot = stream;
				const depth = before.snapshot ? await this.snapshotDepth(before.snapshot) + 1 : 0;
				snapshotRow = before.snapshot && key && depth < SNAPSHOT_INTERVAL ? {
					id: snapshot,
					room_id: roomId,
					prev: before.snapshot,
					depth,
					state: { [key]: eventId }
				} : {
					id: snapshot,
					room_id: roomId,
					prev: null,
					depth: 0,
					state: afterIds
				};
			}
			const unsigned = { ...pdu.unsigned };
			if (prevState) {
				unsigned.prev_content = prevState.content;
				unsigned.prev_sender = prevState.sender;
				unsigned.replaces_state = prevState.event_id;
			}
			if (pdu.type === M.ROOM.MEMBER && (pdu.content.membership === "invite" || pdu.content.membership === "knock") && opts.local) unsigned[pdu.content.membership === "invite" ? "invite_room_state" : "knock_room_state"] = this.strippedState(beforeMap);
			const stored = Object.keys(unsigned).length ? {
				...pdu,
				unsigned
			} : pdu;
			const view = stored.room_id ? stored : {
				...stored,
				room_id: roomId
			};
			const txnToken = opts.txnId && opts.deviceId ? txnTokenOf(sender, opts.deviceId) : null;
			const relation = pdu.content?.[M.RELATES_TO];
			const redactsId = features.v11 ? pdu.content?.redacts : pdu.redacts;
			const redaction = pdu.type === M.ROOM.REDACTION && typeof redactsId === "string" ? await this.prepareRedaction(redactsId, view, version) : null;
			let newExtremities = null;
			let stateChanges = [];
			let newCurrentIds = null;
			if (!backfill) {
				const prevIds = new Set((pdu.prev_events ?? []).map(eventIdOf));
				newExtremities = [...(await this.extremities(roomId)).filter((id) => !prevIds.has(id)), eventId];
				const oldCurrent = await this.currentStateIds(roomId);
				if (newExtremities.length === 1) newCurrentIds = afterIds;
				else {
					const sets = [afterIds];
					for (const ext of newExtremities) {
						if (ext === eventId) continue;
						const snap = await this.snapshotOf(ext);
						if (snap !== null) sets.push(await this.snapshotIds(snap));
					}
					const createEvent = features.v12 ? beforeMap.get(stateKey(M.ROOM.CREATE, "")) ?? (pdu.type === M.ROOM.CREATE ? pdu : void 0) : void 0;
					newCurrentIds = await resolveState(sets, version, async (ids) => {
						const found = await this.getPdus(ids);
						if (ids.includes(eventId)) found.set(eventId, view);
						return found;
					}, createEvent);
				}
				for (const k of /* @__PURE__ */ new Set([...Object.keys(oldCurrent), ...Object.keys(newCurrentIds)])) if (oldCurrent[k] !== newCurrentIds[k]) stateChanges.push({
					key: k,
					eventId: newCurrentIds[k] ?? null
				});
			}
			const changedPdus = await this.getPdus(stateChanges.map((c) => c.eventId).filter((x) => !!x && x !== eventId));
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
					gap: !!opts.gap
				});
				await db.delete("outliers", [{
					field: "event_id",
					value: eventId
				}]);
				const edge = pdu.content?.[M.RELATIONSHIP];
				if (isObject(edge) && typeof edge.event_id === "string" && typeof edge.rel_type === "string") await db.upsert("event_edges", {
					event_id: eventId,
					room_id: roomId,
					parent_id: edge.event_id,
					rel_type: edge.rel_type,
					ts: pdu.origin_server_ts ?? 0,
					depth: pdu.depth ?? 0
				});
				if (isObject(relation) && typeof relation.event_id === "string" && typeof relation.rel_type === "string") await db.upsert("relations", {
					event_id: eventId,
					room_id: roomId,
					parent_id: relation.event_id,
					rel_type: relation.rel_type,
					type: pdu.type,
					sender,
					stream
				});
				if (newExtremities) {
					for (const prev of (pdu.prev_events ?? []).map(eventIdOf)) await db.delete("forward_extremities", [{
						field: "room_id",
						value: roomId
					}, {
						field: "event_id",
						value: prev
					}]);
					await db.upsert("forward_extremities", {
						room_id: roomId,
						event_id: eventId
					});
				}
				for (const change of stateChanges) {
					const [type, sk] = splitStateKey(change.key);
					const where = [
						{
							field: "room_id",
							value: roomId
						},
						{
							field: "type",
							value: type
						},
						{
							field: "state_key",
							value: sk
						}
					];
					if (change.eventId === null) {
						await db.delete("current_state", where);
						if (type === M.ROOM.MEMBER) await db.delete("memberships", [{
							field: "room_id",
							value: roomId
						}, {
							field: "user_id",
							value: sk
						}]);
						continue;
					}
					await db.upsert("current_state", {
						room_id: roomId,
						type,
						state_key: sk,
						event_id: change.eventId
					});
					if (type === M.ROOM.MEMBER) {
						const member = changedPdus.get(change.eventId);
						await db.upsert("memberships", {
							room_id: roomId,
							user_id: sk,
							membership: member?.content?.membership ?? "leave",
							event_id: change.eventId,
							stream,
							forgotten: false
						});
					}
				}
				if (redaction) {
					await db.update("events", [{
						field: "event_id",
						value: redaction.targetId
					}], {
						json: redaction.redacted,
						redacted_by: eventId
					});
					await db.delete("relations", [{
						field: "event_id",
						value: redaction.targetId
					}]);
				}
			});
			this.outlierCache.delete(eventId);
			if (snapshotRow) {
				this.snapshotCache.set(snapshot, afterIds);
				this.snapshotDepths.set(snapshot, snapshotRow.depth);
			}
			this.eventCache.set(eventId, {
				pdu: view,
				stream,
				snapshot,
				txnId: txnToken ? opts.txnId : null,
				txnToken,
				gap: !!opts.gap
			});
			if (newExtremities) this.extremityCache.set(roomId, newExtremities);
			let newState = await this.currentState(roomId);
			if (stateChanges.length) {
				newState = new Map(newState);
				for (const c of stateChanges) if (c.eventId === null) newState.delete(c.key);
				else newState.set(c.key, changedPdus.get(c.eventId));
				this.stateCache.set(roomId, newState);
			}
			if (redaction) this.commitRedaction(redaction, roomId);
			this.invalidate({
				rooms: newExtremities ? [roomId] : [],
				events: [eventId, ...redaction ? [redaction.targetId] : []],
				sharing: stateChanges.some((c) => c.key.startsWith("m.room.member\0"))
			});
			const memberChanges = stateChanges.filter((c) => c.key.startsWith("m.room.member\0"));
			if (memberChanges.length) {
				this.forgetSharing(newState, memberChanges.map((c) => splitStateKey(c.key)[1]));
				for (const c of memberChanges) {
					const userId = splitStateKey(c.key)[1];
					if (this.hs.isLocalUser(userId) || c.eventId === eventId) await this.hs.keys.markDeviceListChanged(userId, false);
					if (!this.hs.isLocalUser(userId)) {
						const m = changedPdus.get(c.eventId ?? "")?.content?.membership;
						if (m === "join" && prevState?.content?.membership !== "join" && c.eventId === eventId) await this.hs.keys.dropRemoteCache(userId);
						else if (m !== "join" && !await this.hs.keys.isTracked(userId)) await this.hs.keys.dropRemoteCache(userId);
					}
					const joinedNow = changedPdus.get(c.eventId ?? "")?.content?.membership === "join";
					const wasJoined = c.eventId === eventId && prevState?.content?.membership === "join";
					if (this.hs.isLocalUser(userId) && joinedNow && !wasJoined) {
						const to = this.hs.federation.serversInRoom(newState);
						if (to.size) this.hs.federation.onDeviceListChange(userId, void 0, to).catch((err) => this.hs.logger.warn("Device list update to federation failed", err));
					}
				}
			}
			if (!backfill) {
				const storedEvent = this.eventCache.get(eventId);
				try {
					await this.hs.push.onEvent(storedEvent, newState, version);
				} catch (err) {
					this.hs.logger.error("Push processing failed for", eventId, err);
				}
				if (opts.local && !opts.noFederate) this.hs.federation.onLocalEvent(view, newState);
				if (this.hs.appservices.registrations.length) await this.hs.appservices.onEvent(view, newState).catch((err) => this.hs.logger.warn("Appservice push failed", err));
				if (isState) await this.hs.delayedEvents.onStateEvent(roomId, pdu.type, pdu.state_key, sender).catch((err) => this.hs.logger.warn("Delayed events state update failed", err));
				if (key === stateKey(M.ROOM.GUEST_ACCESS, "") && pdu.content?.guest_access !== "can_join") this.hs.membership.removeGuests(roomId).catch((err) => this.hs.logger.warn("Could not remove guests from", roomId, err));
				wake = async () => {
					this.hs.notifier.notify(await this.interestedUsers(roomId), backfill ? void 0 : stream);
					this.hs.emit("event", toClientEvent(view));
					if (this.hs.adminRoom) this.hs.adminRoom.onEvent(view).catch((err) => this.hs.logger.error("Admin command failed", err));
				};
			}
		} finally {
			await lease?.done();
		}
		await wake?.();
		return {
			eventId,
			status: "persisted"
		};
	}
	async snapshotDepth(id) {
		const cached = this.snapshotDepths.get(id);
		if (cached !== void 0) return cached;
		const depth = (await this.hs.db.findOne("state_snapshots", [{
			field: "id",
			value: id
		}]))?.depth ?? 0;
		this.snapshotDepths.set(id, depth);
		return depth;
	}
	async membership(roomId, userId) {
		return membershipOf(await this.currentState(roomId), userId);
	}
	async requireJoined(roomId, userId) {
		if (!await this.exists(roomId)) throw errors.forbidden("You are not in this room");
		const state = await this.currentState(roomId);
		if (membershipOf(state, userId) !== "join") throw errors.forbidden("You are not joined to this room");
		return state;
	}
	async joinedMembers(roomId) {
		return (await this.hs.db.findMany("memberships", { where: [{
			field: "room_id",
			value: roomId
		}, {
			field: "membership",
			value: "join"
		}] })).map((r) => r.user_id);
	}
	/** Users that should be woken up for events in this room. */
	async interestedUsers(roomId) {
		return (await this.hs.db.findMany("memberships", { where: [{
			field: "room_id",
			value: roomId
		}] })).map((r) => r.user_id);
	}
	async roomsForUser(userId, membership = "join") {
		return (await this.hs.db.findMany("memberships", { where: [{
			field: "user_id",
			value: userId
		}, {
			field: "membership",
			value: membership
		}] })).map((r) => r.room_id);
	}
	/**
	* Membership changes after `since` in the rooms where `userId` has a membership (in any state),
	* given the user's own membership rows if the caller has them.
	*
	* https://github.com/k18k/katrix/issues/31: /sync and device-list tracking
	* read every membership change on the server since their token and kept those in the user's
	* rooms; while many users joined, each sync parsed thousands of rows. This reads those rooms only.
	*/
	async membershipChangesSince(userId, since, mine) {
		const own = mine ?? await this.hs.db.findMany("memberships", { where: [{
			field: "user_id",
			value: userId
		}] });
		const rooms = [...new Set(own.map((m) => m.room_id))];
		if (rooms.length === 0) return [];
		return this.hs.db.findMany("memberships", { where: [{
			field: "room_id",
			operator: "in",
			value: rooms
		}, {
			field: "stream",
			operator: "gt",
			value: since
		}] });
	}
	/**
	* Drop the cached sets of users sharing a room that a membership change in a room can change: those of the users whose
	* membership changed and of the room's joined members. Every join cleared them all, so each sync it woke (every member
	* of the room) computed its own again.
	*/
	forgetSharing(state, changedUsers) {
		for (const u of changedUsers) this.sharingCache.delete(u);
		for (const [key, ev] of state) {
			const [type, member] = splitStateKey(key);
			if (type === M.ROOM.MEMBER && ev.content?.membership === "join") this.sharingCache.delete(member);
		}
	}
	/** All users sharing at least one joined room with `userId` (including themselves). */
	async usersSharingRooms(userId) {
		const cached = this.sharingCache.get(userId);
		if (cached) return new Set(cached);
		const out = /* @__PURE__ */ new Set([userId]);
		for (const roomId of await this.roomsForUser(userId)) for (const u of await this.joinedMembers(roomId)) out.add(u);
		if (this.sharingCache.size > 1e4) this.sharingCache.clear();
		this.sharingCache.set(userId, out);
		return new Set(out);
	}
	async prepareRedaction(targetId, redaction, version) {
		const target = await this.getEvent(targetId);
		if (!target || target.pdu.room_id !== redaction.room_id) return null;
		const state = await this.currentState(redaction.room_id);
		const pl = powerLevels(state, version);
		if (target.pdu.sender !== redaction.sender && userLevel(pl, redaction.sender) < pl.redact) return null;
		const redacted = redactPdu(target.pdu, version);
		redacted.unsigned = { redacted_because: toClientEvent(redaction) };
		if (target.pdu.unsigned?.prev_content) redacted.unsigned.prev_content = target.pdu.unsigned.prev_content;
		return {
			targetId,
			target,
			redacted
		};
	}
	commitRedaction(r, roomId) {
		const view = r.redacted.room_id ? r.redacted : {
			...r.redacted,
			room_id: roomId
		};
		this.eventCache.set(r.targetId, {
			...r.target,
			pdu: view
		});
		if (r.target.pdu.state_key !== void 0) {
			const key = stateKey(r.target.pdu.type, r.target.pdu.state_key);
			const cur = this.stateCache.get(roomId);
			if (cur?.get(key)?.event_id === r.targetId) this.stateCache.set(roomId, new Map(cur).set(key, view));
		}
	}
	/** Check whether a redaction would be permitted, before sending it. */
	async checkRedactionAllowed(roomId, sender, targetId) {
		const version = await this.roomVersion(roomId);
		const state = await this.currentState(roomId);
		const pl = powerLevels(state, version);
		const target = await this.getEvent(targetId);
		if (target && target.pdu.room_id === roomId && target.pdu.sender !== sender && userLevel(pl, sender) < pl.redact) throw errors.forbidden("Insufficient power level to redact this event");
	}
	/**
	* Room state shared with invitees and knockers (MSC4311): full PDUs in federation
	* format, including the create event. Clients receive stripped versions.
	*/
	strippedState(state) {
		const types = [
			M.ROOM.CREATE,
			M.ROOM.JOIN_RULES,
			M.ROOM.NAME,
			M.ROOM.AVATAR,
			M.ROOM.CANONICAL_ALIAS,
			M.ROOM.ENCRYPTION,
			M.ROOM.TOPIC
		];
		const create = getState(state, M.ROOM.CREATE);
		const version = typeof create?.content?.room_version === "string" ? create.content.room_version : "1";
		return types.flatMap((t) => {
			const ev = getState(state, t);
			return ev ? [this.hs.federation.toFederationPdu(ev, version)] : [];
		});
	}
	/** Filter events down to those `userId` may see according to history visibility. */
	async filterVisible(userId, roomId, events) {
		if (events.length === 0) return events;
		let memberHistory = null;
		const loadHistory = async () => {
			if (memberHistory) return memberHistory;
			if (!userId) return memberHistory = [];
			memberHistory = (await this.hs.db.findMany("events", { where: [
				{
					field: "room_id",
					value: roomId
				},
				{
					field: "type",
					value: M.ROOM.MEMBER
				},
				{
					field: "state_key",
					value: userId
				}
			] })).map((r) => ({
				stream: r.stream,
				membership: r.json.content?.membership
			}));
			return memberHistory;
		};
		const out = [];
		for (const raw of events) {
			const ids = await this.snapshotIds(raw.snapshot);
			let membership = "leave";
			if (userId) {
				const memId = ids[stateKey(M.ROOM.MEMBER, userId)];
				membership = memId ? stringOrUndefined((await this.getEvent(memId))?.pdu.content?.membership) ?? "leave" : "leave";
			}
			const ev = userId ? {
				...raw,
				viewerMembership: membership
			} : raw;
			if (userId && ev.pdu.type === M.ROOM.MEMBER && ev.pdu.state_key === userId) {
				out.push(ev);
				continue;
			}
			const hvId = ids[stateKey(M.ROOM.HISTORY_VISIBILITY, "")];
			const hv = hvId ? (await this.getEvent(hvId))?.pdu.content?.history_visibility ?? "shared" : "shared";
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
				if (history.reduce((a, h) => !a || h.stream > a.stream ? h : a, null)?.membership === "join" || history.some((h) => h.stream >= ev.stream && h.membership === "join")) {
					out.push(ev);
					continue;
				}
			}
		}
		return out;
	}
	/** Whether the user may view the room's current state / history at all (`world_readable` or member). */
	async canPeek(roomId, userId) {
		const state = await this.currentState(roomId);
		const membership = membershipOf(state, userId);
		const hv = getState(state, M.ROOM.HISTORY_VISIBILITY)?.content?.history_visibility ?? "shared";
		return {
			joined: membership === "join",
			worldReadable: hv === "world_readable",
			membership
		};
	}
	/** The state snapshot visible to a user who is no longer joined (state at their leave). */
	async membershipEvent(roomId, userId) {
		const state = await this.currentState(roomId);
		const ev = getState(state, M.ROOM.MEMBER, userId);
		return ev?.event_id ? this.getEvent(ev.event_id) : null;
	}
	formatEvent(ev, viewer, opts = {}) {
		const client = toClientEvent(ev.pdu, opts);
		if (viewer && ev.txnToken && ev.txnToken === txnTokenOf(viewer.userId, viewer.deviceId)) client.unsigned = {
			...client.unsigned,
			transaction_id: ev.txnId
		};
		if (ev.viewerMembership) client.unsigned = {
			...client.unsigned,
			membership: ev.viewerMembership
		};
		return client;
	}
	stateToList(state) {
		return [...state.values()];
	}
	async createRoom(sender, body) {
		const req = parseCreateRoom(body, this.hs.config.defaultRoomVersion);
		const { version, visibility, preset } = req;
		const features = roomVersionFeatures(version);
		const alias = req.aliasName === void 0 ? void 0 : `#${req.aliasName}:${this.hs.serverName}`;
		if (alias && await this.hs.db.findOne("room_aliases", [{
			field: "alias",
			value: alias
		}])) throw errors.roomInUse();
		const { creator: _creator, additional_creators: extra, ...requested } = req.creationContent;
		const createContent = {
			...requested,
			room_version: version,
			...features.v11 ? {} : { creator: sender }
		};
		const creators = /* @__PURE__ */ new Set();
		if (features.v12) {
			if (extra !== void 0 && (!Array.isArray(extra) || !extra.every(isValidUserId))) throw errors.badJson("additional_creators must be a list of user IDs");
			const additional = new Set(extra ?? []);
			if (preset === "trusted_private_chat") for (const u of req.invite) additional.add(u);
			additional.delete(sender);
			if (additional.size) createContent.additional_creators = [...additional];
			creators.add(sender);
			for (const u of additional) creators.add(u);
		}
		let roomId;
		let prebuiltCreate;
		if (features.v12) {
			const create = {
				sender,
				type: M.ROOM.CREATE,
				state_key: "",
				content: createContent,
				origin_server_ts: Date.now(),
				depth: 1,
				prev_events: [],
				auth_events: []
			};
			prebuiltCreate = finalisePdu(create, version, this.hs.serverName, this.hs.signingKey);
			roomId = `!${prebuiltCreate.event_id.slice(1)}`;
		} else roomId = generateRoomId(this.hs.serverName);
		await this.hs.db.create("rooms", {
			room_id: roomId,
			room_version: version,
			creator: sender,
			is_public: visibility === "public",
			created_ts: Date.now()
		});
		this.versions.set(roomId, version);
		const send = (draft) => this.sendEvent(roomId, sender, draft);
		if (prebuiltCreate) {
			const pdu = prebuiltCreate;
			await this.withLock(roomId, () => this.persistEvent(roomId, version, pdu, { local: true }));
		} else await send({
			type: M.ROOM.CREATE,
			state_key: "",
			content: createContent
		});
		const profile = await this.hs.profile(sender);
		await send({
			type: M.ROOM.MEMBER,
			state_key: sender,
			content: {
				membership: "join",
				...profile
			}
		});
		const users = features.v12 ? {} : { [sender]: 100 };
		if (preset === "trusted_private_chat" && !features.v12) for (const u of req.invite) users[u] = 100;
		const pl = {
			users,
			users_default: 0,
			events: {
				[M.ROOM.NAME]: 50,
				[M.ROOM.POWER_LEVELS]: 100,
				[M.ROOM.HISTORY_VISIBILITY]: 100,
				[M.ROOM.CANONICAL_ALIAS]: 50,
				[M.ROOM.AVATAR]: 50,
				[M.ROOM.TOMBSTONE]: features.v12 ? 150 : 100,
				[M.ROOM.SERVER_ACL]: 100,
				[M.ROOM.ENCRYPTION]: 100
			},
			events_default: 0,
			state_default: 50,
			ban: 50,
			kick: 50,
			redact: 50,
			invite: preset === "public_chat" ? 50 : 0,
			notifications: { room: 50 }
		};
		const initialState = req.initialState;
		const initialPl = initialPowerLevels(initialState);
		const predecessor = isObject(createContent.predecessor) ? createContent.predecessor.room_id : void 0;
		if (typeof predecessor === "string") await copyRoomPushRules(this.hs, sender, predecessor, roomId);
		const plContent = {
			...pl,
			...req.override,
			...initialPl?.content
		};
		validatePowerLevelContent(plContent, creators);
		await send({
			type: M.ROOM.POWER_LEVELS,
			state_key: "",
			content: plContent
		});
		if (alias) {
			await this.hs.db.create("room_aliases", {
				alias,
				room_id: roomId,
				creator: sender
			});
			await send({
				type: M.ROOM.CANONICAL_ALIAS,
				state_key: "",
				content: { alias }
			});
		}
		const presetState = [[M.ROOM.JOIN_RULES, { join_rule: preset === "public_chat" ? "public" : "invite" }], [M.ROOM.HISTORY_VISIBILITY, { history_visibility: "shared" }]];
		if (preset !== "public_chat") presetState.push([M.ROOM.GUEST_ACCESS, { guest_access: "can_join" }]);
		const initialKeys = new Set(initialState.map((e) => stateKey(e.type, e.state_key)));
		for (const [type, content] of presetState) if (!initialKeys.has(stateKey(type, ""))) await send({
			type,
			state_key: "",
			content
		});
		for (const ev of initialState) {
			if (ev.type === M.ROOM.POWER_LEVELS || ev.type === M.ROOM.CREATE || ev.type === M.ROOM.MEMBER) continue;
			await send(ev);
		}
		const { name, topic } = req;
		if (name !== void 0) await send({
			type: M.ROOM.NAME,
			state_key: "",
			content: { name }
		});
		if (topic !== void 0) await send({
			type: M.ROOM.TOPIC,
			state_key: "",
			content: {
				topic,
				[M.TOPIC]: { [M.TEXT]: [{
					mimetype: "text/plain",
					body: topic
				}] }
			}
		});
		for (const invitee of req.invite) await this.hs.membership.invite(roomId, sender, invitee, { isDirect: req.isDirect }).catch((err) => {
			if (!(err instanceof MatrixError && err.errcode === "M_INVITE_BLOCKED")) throw err;
		});
		return alias ? {
			room_id: roomId,
			room_alias: alias
		} : { room_id: roomId };
	}
	/** Whether the room was created on this server and we still have its state. */
	async isLocallyHosted(roomId) {
		if (!await this.exists(roomId)) return false;
		const create = await this.createEventOf(roomId);
		return !!create && this.hs.isLocalUser(create.sender);
	}
	/** Whether any local user is joined to the room (i.e. this server participates in it). */
	async serverIsJoined(roomId) {
		if (!await this.exists(roomId)) return false;
		for (const [key, ev] of await this.currentState(roomId)) {
			const [type, userId] = splitStateKey(key);
			if (type === M.ROOM.MEMBER && ev.content?.membership === "join" && this.hs.isLocalUser(userId)) return true;
		}
		return false;
	}
	/**
	* Record a membership event for a room this server may not participate in (remote
	* invites, rejections, knocks) so that it shows up in /sync.
	*/
	async recordRemoteMembership(pdu, version) {
		await this.hs.db.upsert("outliers", {
			event_id: pdu.event_id,
			room_id: pdu.room_id,
			json: pdu,
			state_snapshot: null,
			rejected: null,
			soft_failed: false
		});
		this.outlierCache.delete(pdu.event_id);
		if (!await this.serverIsJoined(pdu.room_id)) await this.hs.streams.write((stream) => this.hs.db.upsert("memberships", {
			room_id: pdu.room_id,
			user_id: pdu.state_key,
			membership: pdu.content?.membership,
			event_id: pdu.event_id,
			stream,
			forgotten: false
		}));
		this.sharingCache.clear();
		this.invalidate({
			events: [pdu.event_id],
			sharing: true
		});
		this.hs.notifier.notify([pdu.state_key]);
	}
};
export { MissingStateError, RoomService, txnTokenOf, validatePowerLevelContent };

//# sourceMappingURL=rooms.js.map