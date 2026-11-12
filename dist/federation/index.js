import { parseId } from "../shared/ids.js";
import { isObject, isStrings } from "../shared/json.js";
import { M } from "../shared/m.js";
import { globMatch } from "../shared/glob.js";
import { unpaddedBase64, urlSafeBase64 } from "../core/crypto.js";
import { SUPPORTED_ROOM_VERSIONS, computeContentHash, computeReferenceHash, eventIdOf, finalisePdu, isPdu, redact, roomVersionFeatures, splitStateKey, stateKey, stripState } from "../core/events.js";
import { MatrixError, errors } from "../core/errors.js";
import { authStateFromAuthEvents, checkAuth, getState, membershipOf } from "../core/authrules.js";
import { resolveState } from "../core/stateres.js";
import { MissingStateError } from "../core/rooms.js";
import { publicGet } from "../core/outbound.js";
import { FederationClient } from "./client.js";
import { KeyRing } from "./keyring.js";
import { TransactionSender } from "./sender.js";
// src/federation/index.ts
const domainOf = (id) => id.slice(id.indexOf(":") + 1);
/** Server ACL check (m.room.server_acl). */
function serverAllowedByAcl(state, serverName) {
	const acl = getState(state, M.ROOM.SERVER_ACL)?.content;
	if (!isObject(acl)) return true;
	const host = serverName.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
	if (acl.allow_ip_literals === false && (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":"))) return false;
	const matches = (p) => typeof p === "string" && globMatch(p, host, { caseInsensitive: true });
	if (Array.isArray(acl.deny) && acl.deny.some(matches)) return false;
	if (!Array.isArray(acl.allow)) return false;
	return acl.allow.some(matches);
}
/** Server-server API: verification, inbound processing and outbound requests. */
var FederationService = class {
	hs;
	enabled;
	fasterJoins;
	client;
	keyring;
	sender;
	options;
	seenTxns = /* @__PURE__ */ new Map();
	deviceStreams = /* @__PURE__ */ new Map();
	constructor(hs, options = {}) {
		this.hs = hs;
		this.options = options;
		this.enabled = options.enabled === true;
		this.fasterJoins = options.fasterJoins !== false;
		this.client = new FederationClient(hs, { rejectUnauthorized: options.verifyTls !== false });
		this.keyring = new KeyRing(hs);
		this.sender = new TransactionSender(hs);
	}
	serverAllowed(serverName) {
		if (this.options.blockedServers?.includes(serverName)) return false;
		if (this.options.allowedServers && !this.options.allowedServers.includes(serverName)) return false;
		return true;
	}
	requireEnabled() {
		if (!this.enabled) throw errors.forbidden("Federation is disabled");
	}
	/** Convert a stored event into its federation (wire) format. */
	toFederationPdu(pdu, version) {
		const { unsigned: _unsigned, event_id, room_id, ...rest } = pdu;
		const f = roomVersionFeatures(version);
		return {
			...rest,
			...f.legacyEventIds && { event_id },
			...!(f.v12 && pdu.type === M.ROOM.CREATE) && { room_id }
		};
	}
	computeEventId(raw, version) {
		const f = roomVersionFeatures(version);
		if (f.legacyEventIds) {
			if (typeof raw.event_id !== "string") throw errors.badJson("Missing event ID");
			return raw.event_id;
		}
		const hash = computeReferenceHash(raw, version);
		return `$${f.urlSafeEventIds ? urlSafeBase64(hash) : unpaddedBase64(hash)}`;
	}
	/**
	* Verify an incoming PDU: event ID, signatures and content hash. Events with a bad
	* content hash are redacted (as the spec requires) rather than rejected.
	*/
	async verifyPdu(raw, version, roomId) {
		if (!isPdu(raw)) throw errors.badJson("Malformed PDU");
		const f = roomVersionFeatures(version);
		if (!f.v12 || raw.type !== M.ROOM.CREATE) {
			if (raw.room_id !== roomId) throw errors.badJson("PDU room_id mismatch");
		}
		const eventId = this.computeEventId(raw, version);
		const redacted = redact(raw, version);
		const senderDomain = domainOf(raw.sender);
		if (!await this.keyring.verifySignedBy(redacted, senderDomain, typeof raw.origin_server_ts === "number" ? raw.origin_server_ts : void 0)) throw errors.forbidden(`Event ${eventId} is not signed by ${senderDomain}`);
		if (f.legacyEventIds && domainOf(eventId) !== senderDomain && !await this.keyring.verifySignedBy(redacted, domainOf(eventId))) throw errors.forbidden(`Event ${eventId} is not signed by its origin`);
		let joinAuthorisedSignatureValid;
		const via = raw.content?.join_authorised_via_users_server;
		if (f.restricted && raw.type === M.ROOM.MEMBER && raw.content?.membership === "join" && typeof via === "string" && via.includes(":")) joinAuthorisedSignatureValid = await this.keyring.verifySignedBy(redacted, domainOf(via));
		let pdu = {
			...raw,
			event_id: eventId
		};
		if (raw.hashes?.sha256 !== computeContentHash(raw)) pdu = {
			...redact(raw, version),
			event_id: eventId
		};
		if (f.v12 && pdu.type === M.ROOM.CREATE) pdu.room_id = roomId;
		return {
			pdu,
			joinAuthorisedSignatureValid
		};
	}
	/** Servers with joined members in a room (excluding ourselves). */
	serversInRoom(state, applyAcl = true) {
		const servers = /* @__PURE__ */ new Set();
		for (const [key, ev] of state) {
			const [type, userId] = splitStateKey(key);
			if (type === M.ROOM.MEMBER && ev.content?.membership === "join") servers.add(domainOf(userId));
		}
		servers.delete(this.hs.serverName);
		for (const s of servers) if (!this.serverAllowed(s) || applyAcl && !serverAllowedByAcl(state, s)) servers.delete(s);
		return servers;
	}
	/**
	* Servers to send a room's traffic to: joined servers per the state, plus, while the room's
	* state is partial (MSC3902), the servers the resident server said were in the room.
	*/
	async roomDestinations(roomId, state, applyAcl = true) {
		const destinations = this.serversInRoom(state, applyAcl);
		for (const s of await this.hs.partialState.servers(roomId)) if (s !== this.hs.serverName && this.serverAllowed(s) && (!applyAcl || serverAllowedByAcl(state, s))) destinations.add(s);
		return destinations;
	}
	/** Send a newly created local event to every server in the room. */
	onLocalEvent(pdu, state) {
		if (!this.enabled) return;
		(async () => {
			const destinations = await this.roomDestinations(pdu.room_id, state, pdu.type !== M.ROOM.SERVER_ACL);
			if (pdu.type === M.ROOM.MEMBER && typeof pdu.state_key === "string" && !this.hs.isLocalUser(pdu.state_key)) destinations.add(domainOf(pdu.state_key));
			if (!destinations.size) return;
			const version = await this.hs.rooms.roomVersion(pdu.room_id) ?? "10";
			await this.sender.sendPdu(destinations, this.toFederationPdu(pdu, version));
		})().catch((err) => this.hs.logger.warn("Failed to queue PDU", err));
	}
	/** Send an EDU to every server in the given rooms. */
	async sendEduToRooms(roomIds, eduType, content, durable = true) {
		if (!this.enabled) return;
		const destinations = /* @__PURE__ */ new Set();
		for (const roomId of roomIds) {
			if (!await this.hs.rooms.exists(roomId)) continue;
			for (const s of await this.roomDestinations(roomId, await this.hs.rooms.currentState(roomId))) destinations.add(s);
		}
		if (destinations.size) await this.sender.sendEdu(destinations, eduType, content, durable);
	}
	/** Servers sharing a room with a local user. */
	async serversSharingRooms(userId) {
		const out = /* @__PURE__ */ new Set();
		for (const roomId of await this.hs.rooms.roomsForUser(userId)) for (const s of await this.roomDestinations(roomId, await this.hs.rooms.currentState(roomId))) out.add(s);
		return out;
	}
	async onTyping(roomId, userId, typing) {
		if (this.hs.isLocalUser(userId)) await this.sendEduToRooms([roomId], M.TYPING, {
			room_id: roomId,
			user_id: userId,
			typing
		}, false);
	}
	async onReceipt(roomId, userId, receiptType, eventId, ts, threadId) {
		if (!this.hs.isLocalUser(userId) || receiptType === M.READ.PRIVATE) return;
		const data = { ts };
		if (threadId) data.thread_id = threadId;
		await this.sendEduToRooms([roomId], M.RECEIPT, { [roomId]: { [receiptType]: { [userId]: {
			event_ids: [eventId],
			data
		} } } });
	}
	async onPresence(userId, presence, statusMsg) {
		if (!this.enabled || !this.hs.isLocalUser(userId)) return;
		const servers = await this.serversSharingRooms(userId);
		if (!servers.size) return;
		await this.sender.sendEdu(servers, M.PRESENCE, { push: [{
			user_id: userId,
			presence,
			last_active_ago: 0,
			currently_active: presence === "online",
			...statusMsg ? { status_msg: statusMsg } : {}
		}] }, false);
	}
	/** Tell servers sharing rooms with a local user that their device list changed. */
	async onDeviceListChange(userId, deletedDeviceId, to) {
		if (!this.enabled || !this.hs.isLocalUser(userId)) return;
		const servers = to ?? await this.serversSharingRooms(userId);
		if (!servers.size) return;
		const devices = await this.hs.db.findMany("devices", { where: [{
			field: "user_id",
			value: userId
		}] });
		const updates = devices.map((d) => ({
			deviceId: d.device_id,
			deleted: false
		}));
		if (deletedDeviceId) updates.push({
			deviceId: deletedDeviceId,
			deleted: true
		});
		for (const u of updates) {
			const prev = this.deviceStreams.get(userId) ?? (await this.hs.db.findOne("device_list_changes", [{
				field: "user_id",
				value: userId
			}]))?.stream ?? 0;
			const streamId = Math.max(await this.hs.streams.write(async (id) => id), prev + 1);
			this.deviceStreams.set(userId, streamId);
			const content = {
				user_id: userId,
				device_id: u.deviceId,
				stream_id: streamId,
				prev_id: prev ? [prev] : []
			};
			if (u.deleted) content.deleted = true;
			else {
				const keys = await this.hs.db.findOne("device_keys", [{
					field: "user_id",
					value: userId
				}, {
					field: "device_id",
					value: u.deviceId
				}]);
				if (keys) content.keys = keys.keys;
				const d = devices.find((x) => x.device_id === u.deviceId);
				if (d?.display_name) content.device_display_name = d.display_name;
			}
			await this.sender.sendEdu(servers, M.DEVICE_LIST_UPDATE, content);
		}
	}
	async onSigningKeyUpdate(userId) {
		if (!this.enabled || !this.hs.isLocalUser(userId)) return;
		const servers = await this.serversSharingRooms(userId);
		if (!servers.size) return;
		const rows = await this.hs.db.findMany("cross_signing_keys", { where: [{
			field: "user_id",
			value: userId
		}] });
		const content = { user_id: userId };
		for (const r of rows) if (r.key_type !== "user_signing") content[`${r.key_type}_key`] = r.key;
		await this.sender.sendEdu(servers, M.SIGNING_KEY_UPDATE, content);
	}
	/** Deliver to-device messages addressed to remote users. */
	async sendToDevice(sender, type, messages, messageId) {
		if (!this.enabled) return;
		const byServer = /* @__PURE__ */ new Map();
		for (const [userId, devices] of Object.entries(messages)) {
			const server = domainOf(userId);
			if (server === this.hs.serverName || !this.serverAllowed(server)) continue;
			(byServer.get(server) ?? byServer.set(server, {}).get(server))[userId] = devices;
		}
		for (const [server, msgs] of byServer) await this.sender.sendEdu([server], M.DIRECT_TO_DEVICE, {
			sender,
			type,
			message_id: `${messageId}-${server}`,
			messages: msgs
		});
	}
	async receiveTransaction(origin, txnId, body) {
		const key = `fedtxn:${origin}|${txnId}`;
		this.sender.wake(origin);
		const local = this.seenTxns.get(key);
		if (local) return local;
		const done = await this.hs.cluster.get(key);
		if (done) return done;
		const p = this.hs.cluster.lock(key, async () => {
			const again = await this.hs.cluster.get(key);
			if (again) return again;
			const result = await this.processTransaction(origin, body);
			await this.hs.cluster.set(key, result, 864e5);
			return result;
		});
		this.seenTxns.set(key, p);
		if (this.seenTxns.size > 1e3) this.seenTxns.delete(this.seenTxns.keys().next().value);
		return p;
	}
	async processTransaction(origin, body) {
		const pdus = Array.isArray(body.pdus) ? body.pdus.slice(0, 50) : [];
		const edus = Array.isArray(body.edus) ? body.edus.slice(0, 100) : [];
		const results = {};
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
		for (const edu of edus) try {
			await this.handleEdu(origin, edu);
		} catch (err) {
			this.hs.logger.debug("EDU from", origin, "failed", err);
		}
		return { pdus: results };
	}
	/**
	* A PDU for a room we are not in can still matter: a local user's invite being
	* rescinded or their knock being accepted/rejected.
	*/
	async handleOutOfRoomMembership(origin, roomId, raw) {
		if (raw?.type !== M.ROOM.MEMBER || typeof raw.state_key !== "string" || !this.hs.isLocalUser(raw.state_key)) throw errors.notFound("Unknown room");
		const row = await this.hs.db.findOne("memberships", [{
			field: "room_id",
			value: roomId
		}, {
			field: "user_id",
			value: raw.state_key
		}]);
		if (!row) throw errors.notFound("Unknown room");
		const previous = await this.hs.rooms.getPdu(row.event_id);
		const strippedCreate = (p) => (p?.unsigned?.invite_room_state ?? p?.unsigned?.knock_room_state ?? []).find((e) => isObject(e) && e.type === M.ROOM.CREATE);
		let create = strippedCreate(previous);
		if (!create) {
			for (const o of await this.hs.db.findMany("outliers", { where: [{
				field: "room_id",
				value: roomId
			}] })) if (create = strippedCreate(o.json)) break;
		}
		const version = typeof create?.content?.room_version === "string" ? create.content.room_version : "1";
		const { pdu } = await this.verifyPdu(raw, version, roomId);
		if (domainOf(pdu.sender) !== origin && domainOf(pdu.sender) !== domainOf(raw.state_key)) throw errors.forbidden("Unexpected sender");
		if (typeof previous?.depth === "number" && typeof pdu.depth === "number" && pdu.depth < previous.depth) return pdu.event_id;
		const membership = pdu.content?.membership;
		if (row.membership === "invite" && (membership === "leave" || membership === "ban") && previous && pdu.sender !== previous.sender && pdu.sender !== raw.state_key) return pdu.event_id;
		if (membership === "invite" || membership === "join") pdu.unsigned = {
			...pdu.unsigned,
			invite_room_state: previous?.unsigned?.knock_room_state ?? previous?.unsigned?.invite_room_state ?? []
		};
		if (membership !== "join") await this.hs.rooms.recordRemoteMembership(pdu, version);
		return pdu.event_id;
	}
	/** Process one incoming PDU (caller holds the room lock). */
	async handlePdu(origin, roomId, version, raw, depth = 0) {
		if (!serverAllowedByAcl(await this.hs.rooms.currentState(roomId), origin)) throw errors.forbidden("Server is denied by the room's ACL");
		const { pdu, joinAuthorisedSignatureValid } = await this.verifyPdu(raw, version, roomId);
		if (await this.hs.rooms.getEvent(pdu.event_id)) return;
		for (const id of (pdu.auth_events ?? []).map(eventIdOf)) if ((await this.hs.rooms.getOutlier(id))?.rejected) {
			await this.hs.db.upsert("outliers", {
				event_id: pdu.event_id,
				room_id: roomId,
				json: pdu,
				state_snapshot: null,
				soft_failed: false,
				rejected: `Auth event ${id} was rejected`
			});
			return;
		}
		let stateBefore;
		const prevIds = (pdu.prev_events ?? []).map(eventIdOf);
		const unknownPrevs = async () => {
			const out = [];
			for (const id of prevIds) {
				if (await this.hs.rooms.snapshotOf(id) !== null) continue;
				if ((await this.hs.rooms.getOutlier(id))?.rejected) continue;
				out.push(id);
			}
			return out;
		};
		let missing = await unknownPrevs();
		if (missing.length && depth < 3) {
			if (!await this.fetchMissingPrevEvents(origin, roomId, version, pdu)) return;
			missing = await unknownPrevs();
		}
		if (missing.length && depth === 0) throw errors.forbidden("Your server isn't divulging details about prev_events referenced in this event.");
		if (missing.length) stateBefore = await this.stateFromPrevs(origin, roomId, version, prevIds);
		await this.fetchMissingAuthEvents(origin, roomId, version, pdu);
		for (const id of (pdu.auth_events ?? []).map(eventIdOf)) {
			const outlier = await this.hs.rooms.getOutlier(id);
			if (outlier?.rejected || !await this.hs.rooms.knowsEvent(id)) {
				await this.hs.db.upsert("outliers", {
					event_id: pdu.event_id,
					room_id: roomId,
					json: pdu,
					state_snapshot: null,
					soft_failed: false,
					rejected: outlier?.rejected ? `Auth event ${id} was rejected` : `Auth event ${id} is unavailable`
				});
				return;
			}
		}
		try {
			const result = await this.hs.rooms.persistEvent(roomId, version, pdu, {
				joinAuthorisedSignatureValid,
				stateBefore,
				gap: !!stateBefore
			});
			if (result.status === "rejected") this.hs.logger.debug("Rejected", pdu.event_id, result.reason);
		} catch (err) {
			if (err instanceof MissingStateError && !stateBefore && depth > 0) {
				const sb = await this.stateFromPrevs(origin, roomId, version, prevIds);
				await this.hs.rooms.persistEvent(roomId, version, pdu, {
					joinAuthorisedSignatureValid,
					stateBefore: sb,
					gap: true
				});
			} else throw err;
		}
	}
	/**
	* State before an event whose predecessors we lack: for each unknown prev event,
	* fetch the state at it (/state_ids) plus the event itself, then resolve all
	* predecessors' states. Throws if a required event cannot be fetched.
	*/
	async stateFromPrevs(origin, roomId, version, prevIds, opts = {}) {
		const sets = [];
		for (const prev of prevIds) {
			const snap = opts.remote ? null : await this.hs.rooms.snapshotOf(prev);
			if (snap !== null) {
				sets.push(await this.hs.rooms.snapshotIds(snap));
				continue;
			}
			if ((await this.hs.rooms.getOutlier(prev))?.rejected) continue;
			const before = await this.fetchStateBefore(origin, roomId, version, prev);
			if (!await this.hs.rooms.getPdu(prev)) await this.fetchEvent(origin, roomId, version, prev);
			const prevPdu = await this.hs.rooms.getPdu(prev);
			if (!prevPdu) throw errors.notFound(`Could not fetch prev event ${prev}`);
			sets.push(prevPdu.state_key !== void 0 ? {
				...before,
				[stateKey(prevPdu.type, prevPdu.state_key)]: prev
			} : before);
		}
		if (!sets.length) throw errors.forbidden("All predecessors were rejected");
		if (sets.length === 1) return sets[0];
		const create = roomVersionFeatures(version).v12 ? await this.hs.rooms.getPdu(`$${roomId.slice(1)}`) ?? void 0 : void 0;
		return resolveState(sets, version, (ids) => this.hs.rooms.getPdus(ids), create);
	}
	async fetchMissingAuthEvents(origin, roomId, version, pdu) {
		const authIds = (pdu.auth_events ?? []).map(eventIdOf);
		const missing = [];
		for (const id of authIds) if (!await this.hs.rooms.knowsEvent(id)) missing.push(id);
		if (!missing.length) return;
		try {
			const res = await this.client.request(origin, "GET", `/_matrix/federation/v1/event_auth/${encodeURIComponent(roomId)}/${encodeURIComponent(pdu.event_id)}`);
			await this.storeOutliers(roomId, version, Array.isArray(res.auth_chain) ? res.auth_chain : []);
		} catch {
			const seen = /* @__PURE__ */ new Set();
			const raws = [];
			let queue = missing;
			while (queue.length && seen.size < 100) {
				const next = [];
				for (const id of queue) {
					if (seen.has(id) || await this.hs.rooms.knowsEvent(id)) continue;
					seen.add(id);
					const raw = await this.fetchRawEvent(origin, id).catch(() => null);
					if (!raw) continue;
					raws.push(raw);
					for (const a of (Array.isArray(raw.auth_events) ? raw.auth_events : []).map(eventIdOf)) if (typeof a === "string") next.push(a);
				}
				queue = next;
			}
			await this.storeOutliers(roomId, version, raws);
		}
	}
	/** Fill a gap with /get_missing_events. Returns false when the response contained invalid events. */
	async fetchMissingPrevEvents(origin, roomId, version, pdu) {
		const earliest = await this.hs.rooms.extremities(roomId);
		let res;
		try {
			res = await this.client.request(origin, "POST", `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(roomId)}`, { body: {
				earliest_events: earliest,
				latest_events: [pdu.event_id],
				limit: 10,
				min_depth: 0
			} });
		} catch {
			return true;
		}
		const events = (isObject(res) && Array.isArray(res.events) ? res.events : []).filter(isObject);
		for (const ev of events) try {
			this.computeEventId(ev, version);
		} catch {
			return false;
		}
		const depthOf = (e) => typeof e.depth === "number" ? e.depth : 0;
		events.sort((a, b) => depthOf(a) - depthOf(b));
		const failed = /* @__PURE__ */ new Set();
		for (const ev of events) try {
			await this.handlePdu(origin, roomId, version, ev, 3);
		} catch (err) {
			failed.add(this.computeEventId(ev, version));
			this.hs.logger.debug("Missing event failed", err);
		}
		return !(pdu.prev_events ?? []).map(eventIdOf).some((id) => failed.has(id));
	}
	/** Fetch one event from a remote server and store it as an outlier. */
	async fetchEvent(origin, roomId, version, eventId) {
		const raw = await this.fetchRawEvent(origin, eventId);
		if (raw) await this.storeOutliers(roomId, version, [raw]);
	}
	async fetchRawEvent(origin, eventId) {
		const r = await this.client.request(origin, "GET", `/_matrix/federation/v1/event/${encodeURIComponent(eventId)}`);
		return Array.isArray(r.pdus) && isObject(r.pdus[0]) ? r.pdus[0] : null;
	}
	/**
	* Fetch the state before an event from a remote server. Uses /state_ids and
	* fetches only unknown events (falling back to /state), storing them as outliers.
	*/
	async fetchStateBefore(origin, roomId, version, eventId) {
		let stateIds;
		let res = null;
		const timeoutMs = 3e5;
		try {
			res = await this.client.request(origin, "GET", `/_matrix/federation/v1/state_ids/${encodeURIComponent(roomId)}`, {
				query: { event_id: eventId },
				timeoutMs
			});
		} catch (err) {
			this.hs.logger.debug("/state_ids failed, falling back to /state", origin, err);
		}
		const stateIdList = isObject(res) && isStrings(res.pdu_ids) ? res.pdu_ids : void 0;
		if (res && !stateIdList?.length) throw errors.notFound("Remote server returned no state");
		if (isObject(res) && stateIdList) {
			stateIds = stateIdList;
			const wanted = [...Array.isArray(res.auth_chain_ids) ? res.auth_chain_ids : [], ...stateIds];
			const missing = [];
			for (const id of wanted) if (typeof id === "string" && !await this.hs.rooms.knowsEvent(id)) missing.push(id);
			const raws = [];
			for (let i = 0; i < missing.length; i += 20) {
				const batch = await Promise.all(missing.slice(i, i + 20).map((id) => this.fetchRawEvent(origin, id).catch(() => null)));
				for (const raw of batch) if (raw) raws.push(raw);
			}
			await this.storeOutliers(roomId, version, raws);
			for (const id of stateIds) if (!await this.hs.rooms.knowsEvent(id)) throw errors.notFound(`Could not fetch state event ${id}`);
		} else {
			const res = await this.client.request(origin, "GET", `/_matrix/federation/v1/state/${encodeURIComponent(roomId)}`, {
				query: { event_id: eventId },
				timeoutMs
			});
			const pdus = Array.isArray(res.pdus) ? res.pdus : [];
			if (!pdus.length) throw errors.notFound("Remote server returned no state");
			await this.storeOutliers(roomId, version, [...Array.isArray(res.auth_chain) ? res.auth_chain : [], ...pdus]);
			stateIds = pdus.filter(isObject).map((raw) => this.computeEventId(raw, version));
		}
		const ids = {};
		const pdus = await this.hs.rooms.getPdus(stateIds);
		for (const id of stateIds) {
			const pdu = pdus.get(id);
			if (pdu && pdu.state_key !== void 0) ids[stateKey(pdu.type, pdu.state_key)] = id;
		}
		return ids;
	}
	/** Verify and store events that are not (yet) part of the timeline. */
	async storeOutliers(roomId, version, raws) {
		const verified = [];
		for (const raw of raws) {
			if (!isObject(raw)) continue;
			try {
				const { pdu } = await this.verifyPdu(raw, version, roomId);
				if (!await this.hs.rooms.knowsEvent(pdu.event_id)) verified.push(pdu);
			} catch (err) {
				this.hs.logger.debug("Dropping invalid outlier", err);
			}
		}
		verified.sort((a, b) => a.depth - b.depth);
		const seen = /* @__PURE__ */ new Set();
		for (const pdu of verified) {
			if (seen.has(pdu.event_id)) continue;
			seen.add(pdu.event_id);
			const rejected = await this.checkOutlierAuth(roomId, version, pdu);
			await this.hs.db.upsert("outliers", {
				event_id: pdu.event_id,
				room_id: roomId,
				json: pdu,
				state_snapshot: null,
				rejected,
				soft_failed: false
			});
		}
	}
	/** Check an outlier against its own auth events. Returns a rejection reason, or null. */
	async checkOutlierAuth(roomId, version, pdu) {
		const authIds = (pdu.auth_events ?? []).map(eventIdOf);
		const authPdus = [];
		for (const id of authIds) {
			if ((await this.hs.rooms.getOutlier(id))?.rejected) return `Auth event ${id} was rejected`;
			const p = await this.hs.rooms.getPdu(id);
			if (!p) return `Auth event ${id} is unavailable`;
			authPdus.push(p);
		}
		try {
			const create = roomVersionFeatures(version).v12 && pdu.type !== M.ROOM.CREATE ? await this.hs.rooms.getPdu(`$${roomId.slice(1)}`) ?? void 0 : void 0;
			checkAuth(pdu, authStateFromAuthEvents(pdu, authPdus, version, create), version);
			return null;
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	}
	/**
	* Whether a remote user's ephemeral activity (typing, receipts) in a room is accepted: they are
	* joined, or the room's state is partial (MSC3902) and their server is one of the room's servers.
	*/
	async mayActInRoom(roomId, userId, origin) {
		const membership = await this.hs.rooms.membership(roomId, userId);
		if (membership === "join") return true;
		if (membership !== "leave" || !await this.hs.partialState.isPartial(roomId)) return false;
		return (await this.hs.partialState.servers(roomId)).includes(origin);
	}
	async handleEdu(origin, edu) {
		const content = edu?.content;
		if (!isObject(content)) return;
		switch (edu.edu_type) {
			case M.TYPING: {
				const { room_id, user_id, typing } = content;
				if (typeof user_id !== "string" || domainOf(user_id) !== origin || typeof room_id !== "string") return;
				if (!await this.hs.rooms.exists(room_id) || !await this.mayActInRoom(room_id, user_id, origin)) return;
				if (!serverAllowedByAcl(await this.hs.rooms.currentState(room_id), origin)) return;
				await this.hs.typing.setTyping(room_id, user_id, !!typing, typeof content.timeout === "number" ? content.timeout : 3e4);
				return;
			}
			case M.RECEIPT:
				for (const [roomId, byType] of Object.entries(content)) {
					if (!isObject(byType) || !await this.hs.rooms.exists(roomId)) continue;
					if (!serverAllowedByAcl(await this.hs.rooms.currentState(roomId), origin)) continue;
					for (const [receiptType, byUser] of Object.entries(byType)) {
						if (receiptType !== M.READ._ && receiptType !== M.READ.PRIVATE || !isObject(byUser)) continue;
						for (const [userId, r] of Object.entries(byUser)) {
							if (domainOf(userId) !== origin || !isObject(r) || !Array.isArray(r.event_ids)) continue;
							if (!await this.mayActInRoom(roomId, userId, origin)) continue;
							const eventId = r.event_ids[r.event_ids.length - 1];
							if (typeof eventId !== "string") continue;
							await this.hs.streams.write((stream) => this.hs.db.upsert("receipts", {
								room_id: roomId,
								user_id: userId,
								receipt_type: receiptType,
								thread_id: isObject(r.data) && typeof r.data.thread_id === "string" ? r.data.thread_id : "",
								event_id: eventId,
								ts: isObject(r.data) && Number(r.data.ts) || Date.now(),
								stream
							}));
						}
					}
					this.hs.notifier.notify(await this.hs.rooms.joinedMembers(roomId));
				}
				return;
			case M.PRESENCE:
				for (const p of Array.isArray(content.push) ? content.push : []) {
					if (!isObject(p) || typeof p.user_id !== "string" || domainOf(p.user_id) !== origin) continue;
					if (p.presence !== "online" && p.presence !== "offline" && p.presence !== "unavailable") continue;
					await this.hs.streams.write((stream) => this.hs.db.upsert("presence", {
						user_id: p.user_id,
						presence: p.presence,
						status_msg: typeof p.status_msg === "string" ? p.status_msg : null,
						last_active_ts: Date.now() - (Number(p.last_active_ago) || 0),
						stream
					}));
					this.hs.notifier.notify(await this.hs.rooms.usersSharingRooms(p.user_id));
				}
				return;
			case M.DEVICE_LIST_UPDATE: {
				const userId = content.user_id;
				if (typeof userId !== "string" || domainOf(userId) !== origin || typeof content.device_id !== "string") return;
				const known = await this.hs.db.findOne("remote_device_lists", [{
					field: "user_id",
					value: userId
				}]);
				if (!await this.hs.keys.isTracked(userId)) await this.hs.partialState.notePendingDeviceUpdate(userId, origin);
				await this.hs.keys.markRemoteStale(userId);
				if (known || content.deleted || isObject(content.keys)) await this.hs.keys.markDeviceListChanged(userId);
				return;
			}
			case M.SIGNING_KEY_UPDATE: {
				const userId = content.user_id;
				if (typeof userId !== "string" || domainOf(userId) !== origin) return;
				for (const type of ["master", "self_signing"]) {
					const key = content[`${type}_key`];
					if (isObject(key)) await this.hs.streams.write((stream) => this.hs.db.upsert("cross_signing_keys", {
						user_id: userId,
						key_type: type,
						key,
						stream
					}));
				}
				await this.hs.keys.markRemoteStale(userId);
				await this.hs.keys.markDeviceListChanged(userId);
				return;
			}
			case M.DIRECT_TO_DEVICE: {
				const { sender, type, message_id, messages } = content;
				if (typeof sender !== "string" || domainOf(sender) !== origin || typeof type !== "string" || !isObject(messages)) return;
				if (!await this.hs.cluster.setIfAbsent(`fedtodevice:${origin}|${message_id}`, true, 864e5)) return;
				const recipients = /* @__PURE__ */ new Set();
				for (const [userId, devices] of Object.entries(messages)) {
					if (!this.hs.isLocalUser(userId) || !isObject(devices)) continue;
					let targets = Object.keys(devices);
					if (targets.includes("*")) targets = (await this.hs.db.findMany("devices", { where: [{
						field: "user_id",
						value: userId
					}] })).map((d) => d.device_id);
					for (const deviceId of targets) await this.hs.streams.write((stream) => this.hs.db.create("to_device", {
						stream,
						user_id: userId,
						device_id: deviceId,
						sender,
						type,
						content: devices[deviceId] ?? devices["*"]
					}));
					recipients.add(userId);
				}
				this.hs.notifier.notify(recipients);
				return;
			}
		}
	}
	/** Build a full event from a make_join/make_leave/make_knock template and sign it. */
	finaliseTemplate(template, version, extraContent) {
		const { event_id, hashes, signatures, unsigned, ...rest } = template;
		const pdu = {
			...rest,
			content: {
				...isObject(rest.content) ? rest.content : {},
				...extraContent
			},
			origin_server_ts: Date.now()
		};
		if (!isPdu(pdu)) throw errors.badJson("Malformed event template");
		if (roomVersionFeatures(version).legacyEventIds) pdu.origin = this.hs.serverName;
		return finalisePdu(pdu, version, this.hs.serverName, this.hs.signingKey);
	}
	/** Join a room hosted on other servers. Returns the room ID. */
	async joinRemoteRoom(userId, roomId, servers, content) {
		this.requireEnabled();
		let lastError = errors.notFound("No server could be reached to join the room");
		for (const server of [...new Set(servers)].filter((s) => s !== this.hs.serverName && this.serverAllowed(s))) try {
			const tmpl = await this.client.request(server, "GET", `/_matrix/federation/v1/make_join/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`, { query: { ver: SUPPORTED_ROOM_VERSIONS } });
			const version = typeof tmpl.room_version === "string" ? tmpl.room_version : "1";
			if (!SUPPORTED_ROOM_VERSIONS.includes(version)) throw errors.unsupportedRoomVersion();
			if (!isObject(tmpl.event) || tmpl.event.content?.membership !== "join" || tmpl.event.state_key !== userId || tmpl.event.sender !== userId) throw errors.badJson("Invalid make_join template");
			const joinPdu = this.finaliseTemplate(tmpl.event, version, content);
			const res = await this.client.request(server, "PUT", `/_matrix/federation/v2/send_join/${encodeURIComponent(roomId)}/${encodeURIComponent(joinPdu.event_id)}`, {
				body: this.toFederationPdu(joinPdu, version),
				query: this.fasterJoins ? { omit_members: "true" } : void 0,
				timeoutMs: 12e4
			});
			if (isObject(res.event?.signatures)) joinPdu.signatures = {
				...joinPdu.signatures,
				...res.event.signatures
			};
			await this.completeJoin(roomId, version, joinPdu, res, server);
			return roomId;
		} catch (err) {
			lastError = err;
			this.hs.logger.debug("Joining", roomId, "via", server, "failed", err);
		}
		throw lastError;
	}
	async completeJoin(roomId, version, joinPdu, res, origin) {
		const statePdus = Array.isArray(res.state) ? res.state : [];
		const authChain = Array.isArray(res.auth_chain) ? res.auth_chain : [];
		await this.storeOutliers(roomId, version, [...authChain, ...statePdus]);
		const stateIds = {};
		let create;
		for (const raw of statePdus) {
			if (!isObject(raw) || typeof raw.state_key !== "string") continue;
			const id = this.computeEventId(raw, version);
			const pdu = await this.hs.rooms.getPdu(id);
			if (!pdu) continue;
			stateIds[stateKey(pdu.type, pdu.state_key)] = id;
			if (pdu.type === M.ROOM.CREATE) create = pdu;
		}
		if (!create) throw errors.badJson("send_join response lacks the create event");
		if (!await this.hs.rooms.exists(roomId)) await this.hs.db.upsert("rooms", {
			room_id: roomId,
			room_version: version,
			creator: create.sender,
			is_public: false,
			created_ts: Date.now()
		});
		if (await this.hs.rooms.serverIsJoined(roomId)) {
			await this.hs.rooms.withLock(roomId, () => this.hs.rooms.persistEvent(roomId, version, joinPdu, {
				local: true,
				noFederate: true
			}));
			return;
		}
		let gap = false;
		for (const prev of (joinPdu.prev_events ?? []).map(eventIdOf)) if (!await this.hs.rooms.getEvent(prev)) gap = true;
		await this.hs.rooms.withLock(roomId, () => this.hs.rooms.persistEvent(roomId, version, joinPdu, {
			local: true,
			stateBefore: stateIds,
			createEvent: roomVersionFeatures(version).v12 ? create : void 0,
			noFederate: true,
			gap
		}));
		if (res.members_omitted === true) {
			const servers = Array.isArray(res.servers_in_room) ? res.servers_in_room.filter((s) => typeof s === "string") : [];
			await this.hs.partialState.markPartial(roomId, joinPdu.event_id, origin, servers);
		}
	}
	/** Leave (or reject an invite to) a room hosted elsewhere. */
	async leaveRemoteRoom(userId, roomId, servers, reason) {
		this.requireEnabled();
		let lastError = errors.notFound("No server could be reached to leave the room");
		for (const server of [...new Set(servers)].filter((s) => s !== this.hs.serverName)) try {
			const tmpl = await this.client.request(server, "GET", `/_matrix/federation/v1/make_leave/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`);
			const version = typeof tmpl.room_version === "string" ? tmpl.room_version : "1";
			const pdu = this.finaliseTemplate(tmpl.event, version, reason ? { reason } : {});
			await this.client.request(server, "PUT", `/_matrix/federation/v2/send_leave/${encodeURIComponent(roomId)}/${encodeURIComponent(pdu.event_id)}`, { body: this.toFederationPdu(pdu, version) });
			return pdu;
		} catch (err) {
			lastError = err;
		}
		throw lastError;
	}
	async knockRemoteRoom(userId, roomId, servers, reason) {
		this.requireEnabled();
		let lastError = errors.notFound("No server could be reached to knock on the room");
		for (const server of [...new Set(servers)].filter((s) => s !== this.hs.serverName)) try {
			const tmpl = await this.client.request(server, "GET", `/_matrix/federation/v1/make_knock/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`, { query: { ver: SUPPORTED_ROOM_VERSIONS } });
			const version = typeof tmpl.room_version === "string" ? tmpl.room_version : "1";
			const pdu = this.finaliseTemplate(tmpl.event, version, reason ? { reason } : {});
			const res = await this.client.request(server, "PUT", `/_matrix/federation/v1/send_knock/${encodeURIComponent(roomId)}/${encodeURIComponent(pdu.event_id)}`, { body: this.toFederationPdu(pdu, version) });
			return {
				pdu,
				knockState: Array.isArray(res.knock_room_state) ? res.knock_room_state : []
			};
		} catch (err) {
			lastError = err;
		}
		throw lastError;
	}
	/** Ask the invitee's server to sign an invite; returns the countersigned event. */
	async sendInvite(pdu, version, inviteRoomState) {
		this.requireEnabled();
		const server = domainOf(pdu.state_key);
		if (!this.serverAllowed(server)) throw errors.forbidden("Federation with this server is not allowed");
		const res = await this.client.request(server, "PUT", `/_matrix/federation/v2/invite/${encodeURIComponent(pdu.room_id)}/${encodeURIComponent(pdu.event_id)}`, { body: {
			room_version: version,
			event: this.toFederationPdu(pdu, version),
			invite_room_state: inviteRoomState
		} });
		if (!isObject(res.event)) throw errors.unknown("Invalid invite response");
		const signed = {
			...pdu,
			signatures: {
				...pdu.signatures,
				...res.event.signatures
			}
		};
		if (!await this.keyring.verifySignedBy(redact(this.toFederationPdu(signed, version), version), server)) throw errors.forbidden("Invite was not signed by the invitee's server");
		return signed;
	}
	async queryProfile(userId, field) {
		this.requireEnabled();
		return this.client.request(domainOf(userId), "GET", "/_matrix/federation/v1/query/profile", { query: {
			user_id: userId,
			field
		} });
	}
	async queryAlias(alias) {
		this.requireEnabled();
		return this.client.request(domainOf(alias), "GET", "/_matrix/federation/v1/query/directory", { query: { room_alias: alias } });
	}
	async queryKeys(deviceKeys, timeoutMs = 1e4) {
		const byServer = /* @__PURE__ */ new Map();
		for (const [userId, devices] of Object.entries(deviceKeys)) {
			const server = domainOf(userId);
			if (server === this.hs.serverName) continue;
			(byServer.get(server) ?? byServer.set(server, {}).get(server))[userId] = devices;
		}
		const results = [];
		const failures = {};
		await Promise.all([...byServer].map(async ([server, query]) => {
			try {
				if (!this.enabled || !this.serverAllowed(server)) throw new Error("Federation disabled");
				results.push(await this.client.request(server, "POST", "/_matrix/federation/v1/user/keys/query", {
					body: { device_keys: query },
					timeoutMs
				}));
			} catch (err) {
				failures[server] = {
					status: 503,
					message: err instanceof Error ? err.message : String(err)
				};
			}
		}));
		return {
			results,
			failures
		};
	}
	async claimKeys(oneTimeKeys, timeoutMs = 1e4) {
		const byServer = /* @__PURE__ */ new Map();
		for (const [userId, devices] of Object.entries(oneTimeKeys)) {
			const server = domainOf(userId);
			if (server === this.hs.serverName) continue;
			(byServer.get(server) ?? byServer.set(server, {}).get(server))[userId] = devices;
		}
		const results = {};
		const failures = {};
		await Promise.all([...byServer].map(async ([server, query]) => {
			try {
				if (!this.enabled) throw new Error("Federation disabled");
				const res = await this.client.request(server, "POST", "/_matrix/federation/v1/user/keys/claim", {
					body: { one_time_keys: query },
					timeoutMs
				});
				Object.assign(results, res.one_time_keys ?? {});
			} catch (err) {
				failures[server] = {
					status: 503,
					message: err instanceof Error ? err.message : String(err)
				};
			}
		}));
		return {
			results,
			failures
		};
	}
	async queryPublicRooms(server, body) {
		this.requireEnabled();
		return this.client.request(server, "POST", "/_matrix/federation/v1/publicRooms", { body });
	}
	async queryHierarchy(server, roomId, suggestedOnly) {
		this.requireEnabled();
		return this.client.request(server, "GET", `/_matrix/federation/v1/hierarchy/${encodeURIComponent(roomId)}`, { query: { suggested_only: String(suggestedOnly) } });
	}
	/**
	* Fetch history preceding the oldest events we have. Returns the number of new
	* events stored. Caller should not hold the room lock.
	*/
	async backfill(roomId, fromEventIds, limit = 50) {
		if (!this.enabled || !fromEventIds.length) return 0;
		const version = await this.hs.rooms.roomVersion(roomId);
		if (!version) return 0;
		const servers = [...await this.roomDestinations(roomId, await this.hs.rooms.currentState(roomId), false)];
		for (const server of servers) try {
			const res = await this.client.request(server, "GET", `/_matrix/federation/v1/backfill/${encodeURIComponent(roomId)}`, { query: {
				v: fromEventIds,
				limit: String(limit)
			} });
			const verified = [];
			for (const raw of Array.isArray(res.pdus) ? res.pdus : []) try {
				const { pdu } = await this.verifyPdu(raw, version, roomId);
				if (!await this.hs.rooms.getEvent(pdu.event_id)) verified.push(pdu);
			} catch {}
			if (!verified.length) return 0;
			verified.sort((a, b) => b.depth - a.depth);
			const positions = /* @__PURE__ */ new Map();
			for (const p of verified) positions.set(p.event_id, await this.hs.streams.backfillId());
			verified.reverse();
			let stored = 0;
			await this.hs.rooms.withLock(roomId, async () => {
				for (const pdu of verified) try {
					await this.fetchMissingAuthEvents(server, roomId, version, pdu);
					let stateBefore;
					const prevIds = (pdu.prev_events ?? []).map(eventIdOf);
					const unknown = [];
					for (const id of prevIds) if (await this.hs.rooms.snapshotOf(id) === null) unknown.push(id);
					if (unknown.length) stateBefore = await this.fetchStateBefore(server, roomId, version, pdu.event_id);
					if ((await this.hs.rooms.persistEvent(roomId, version, pdu, {
						backfill: true,
						stateBefore,
						stream: positions.get(pdu.event_id)
					})).status === "persisted") stored++;
				} catch (err) {
					this.hs.logger.debug("Backfilled event failed", pdu.event_id, err);
				}
			});
			return stored;
		} catch (err) {
			this.hs.logger.debug("Backfill from", server, "failed", err);
		}
		return 0;
	}
	/** Download remote media (authenticated federation endpoint, falling back to the legacy one). */
	async fetchMedia(server, mediaId, maxBytes) {
		this.requireEnabled();
		const res = await this.client.requestRaw(server, "GET", `/_matrix/federation/v1/media/download/${encodeURIComponent(mediaId)}`, { timeoutMs: 6e4 });
		if (res.status === 200) {
			const ct = String(res.headers["content-type"] ?? "");
			const m = /boundary=("?)([^";]+)\1/.exec(ct);
			if (ct.startsWith("multipart/") && m) return parseMultipartMedia(res.body, m[2], {
				maxBytes,
				fetch: this.hs.publicFetch
			});
		}
		const legacy = await this.client.requestRaw(server, "GET", `/_matrix/media/v3/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`, {
			query: { allow_remote: "false" },
			signed: false,
			timeoutMs: 6e4
		});
		if (legacy.status !== 200) throw errors.notFound("Remote media not found");
		return {
			data: legacy.body,
			contentType: legacy.headers["content-type"] ?? null,
			filename: filenameFromDisposition(legacy.headers["content-disposition"])
		};
	}
	/** Remote members who should receive the invitee's stripped state. */
	strippedStateFor(state) {
		return this.hs.rooms.strippedState(state);
	}
	/** Servers that may be able to help us join `roomId`. */
	candidateServers(roomId, extra = []) {
		const fromId = parseId(roomId, "!")?.server;
		return [.../* @__PURE__ */ new Set([...extra, ...fromId ? [fromId] : []])];
	}
	static memberServers(state) {
		const out = /* @__PURE__ */ new Set();
		for (const [key, ev] of state) {
			const [type, userId] = splitStateKey(key);
			if (type === M.ROOM.MEMBER && ev.content?.membership === "join") out.add(domainOf(userId));
		}
		return [...out];
	}
	isMembershipVisibleTo(state, server) {
		for (const [key] of state) {
			const [type, userId] = splitStateKey(key);
			if (type === M.ROOM.MEMBER && domainOf(userId) === server && membershipOf(state, userId) === "join") return true;
		}
		return false;
	}
	stripped(pdu) {
		return stripState(pdu);
	}
	error(status, errcode, message) {
		return new MatrixError(status, errcode, message);
	}
};
function filenameFromDisposition(header) {
	if (!header) return null;
	const star = /filename\*=utf-8''([^;]+)/i.exec(header);
	if (star) return decodeURIComponent(star[1]);
	const plain = /filename="?([^";]+)"?/i.exec(header);
	return plain ? plain[1] : null;
}
/** Parse a federation media multipart/mixed response: a JSON part then the file (or a redirect). */
async function parseMultipartMedia(body, boundary, limits) {
	const delimiter = Buffer.from(`--${boundary}`);
	const parts = [];
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
	const headers = {};
	for (const line of headerText.split("\r\n")) {
		const i = line.indexOf(":");
		if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
	}
	if (headers.location) {
		const res = await publicGet(limits.fetch, headers.location, {
			maxBytes: limits.maxBytes,
			timeoutMs: 6e4
		});
		if (res.status !== 200) throw errors.notFound("Remote media redirect failed");
		return {
			data: new Uint8Array(res.body),
			contentType: res.headers.get("content-type"),
			filename: filenameFromDisposition(res.headers.get("content-disposition") ?? void 0)
		};
	}
	return {
		data: new Uint8Array(data),
		contentType: headers["content-type"] ?? null,
		filename: filenameFromDisposition(headers["content-disposition"])
	};
}
export { FederationService, domainOf, serverAllowedByAcl };

//# sourceMappingURL=index.js.map