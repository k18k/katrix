import { isObject, stringOrUndefined } from "../packages/shared/src/json.js";
import { isValidUserId } from "../packages/shared/src/ids.js";
import { M } from "../packages/shared/src/m.js";
import { eventsByTimestamp } from "./timeline.js";
import { MatrixError, errors } from "../core/errors.js";
import { fullProfile } from "../core/profile.js";
import { relationshipsForServer } from "./relationships.js";
import { authEventKeys, checkAuth, getState, membershipOf, powerLevels, userLevel } from "../core/authrules.js";
import { SUPPORTED_ROOM_VERSIONS, eventIdOf, isPdu, redact, redactPdu, roomVersionFeatures, splitStateKey, stateKey } from "../core/events.js";
import { inviteDecision } from "../core/invitefilter.js";
import { randomToken, signJson, verifyJsonSignature } from "../core/crypto.js";
import { domainOf, serverAllowedByAcl } from "../federation/index.js";
import { parseXMatrix } from "../federation/client.js";
import { procedure } from "../http/procedure.js";
import { v } from "../core/vpm.js";
import { body, lenient } from "../http/input.js";
import { canonicalJsonResponse } from "../http/handler.js";
import { allowedRoomIds, roomDetails } from "./spaces.js";
// src/api/federation.ts
const objectMap = lenient(v.record(v.string(), v.unknown()));
const keyQueryBody = body({ server_keys: objectMap });
const missingEventsBody = body({
	earliest_events: lenient(v.array(v.string())),
	latest_events: lenient(v.array(v.string())),
	limit: v.unknown().optional(),
	min_depth: v.unknown().optional()
});
const userKeysQueryBody = body({ device_keys: objectMap });
const userKeysClaimBody = body({ one_time_keys: objectMap });
const publicRoomsBody = body({
	limit: v.unknown().optional(),
	filter: lenient(v.looseObject({ generic_search_term: lenient(v.string()) }))
});
const F = "/_matrix/federation";
/** Authenticate a server-server request; returns the origin server name. */
async function authenticate(ctx) {
	const hs = ctx.hs;
	if (!hs.federation.enabled) throw errors.unrecognized("Federation is disabled");
	const header = ctx.request.headers.get("authorization") ?? "";
	const auth = parseXMatrix(header.split(/,\s*(?=X-Matrix)/i)[0]);
	if (!auth) throw new MatrixError(401, "M_UNAUTHORIZED", "Missing or invalid X-Matrix authorization");
	if (auth.destination && auth.destination !== hs.serverName) throw new MatrixError(401, "M_UNAUTHORIZED", "Wrong destination");
	if (!hs.federation.serverAllowed(auth.origin)) throw errors.forbidden("Federation with this server is not allowed");
	const bytes = await ctx.bytes();
	const toSign = {
		method: ctx.method,
		uri: ctx.url.pathname + ctx.url.search,
		origin: auth.origin,
		destination: hs.serverName
	};
	if (bytes.length) toSign.content = await ctx.json();
	const key = await hs.federation.keyring.getKey(auth.origin, auth.key);
	if (!key || !verifyJsonSignature({
		...toSign,
		signatures: { [auth.origin]: { [auth.key]: auth.sig } }
	}, auth.origin, auth.key, key)) throw new MatrixError(401, "M_UNAUTHORIZED", "Invalid signature");
	return auth.origin;
}
async function roomOr404(hs, roomId) {
	const version = await hs.rooms.roomVersion(roomId);
	if (!version) throw errors.notFound("Unknown room");
	return version;
}
async function checkAcl(hs, roomId, origin) {
	const state = await hs.rooms.currentState(roomId);
	if (!serverAllowedByAcl(state, origin)) throw errors.forbidden("Server is denied by the room's ACL");
	return state;
}
/** A timeline event, when it belongs to `roomId` (events are looked up by ID across all rooms). */
async function eventInRoom(hs, roomId, eventId) {
	const ev = await hs.rooms.getEvent(eventId);
	return ev && ev.pdu.room_id === roomId ? ev : null;
}
/** Whether `server` may see an event, per history visibility. */
async function serverCanSee(hs, server, ev) {
	const ids = await hs.rooms.snapshotIds(ev.snapshot);
	const hvId = ids[stateKey(M.ROOM.HISTORY_VISIBILITY, "")];
	const hv = hvId ? (await hs.rooms.getPdu(hvId))?.content?.history_visibility ?? "shared" : "shared";
	if (hv === "world_readable" || hv === "shared") return true;
	for (const [key, id] of Object.entries(ids)) {
		const [type, userId] = splitStateKey(key);
		if (type !== M.ROOM.MEMBER || domainOf(userId) !== server) continue;
		const m = (await hs.rooms.getPdu(id))?.content?.membership;
		if (m === "join" || hv === "invited" && m === "invite") return true;
	}
	return false;
}
/** While our state is partial (MSC3902) we cannot vouch for joins or knocks through us. */
async function rejectIfPartial(hs, roomId) {
	if (await hs.partialState.isPartial(roomId)) throw errors.notFound("This server does not yet have the full state of the room");
}
async function authChainOf(hs, ids) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	let frontier = ids;
	while (frontier.length) {
		const next = [];
		const pdus = await hs.rooms.getPdus(frontier);
		for (const id of frontier) {
			const pdu = pdus.get(id);
			if (!pdu) continue;
			for (const a of (pdu.auth_events ?? []).map(eventIdOf)) {
				if (seen.has(a)) continue;
				seen.add(a);
				next.push(a);
			}
		}
		const loaded = await hs.rooms.getPdus(next);
		for (const id of next) {
			const p = loaded.get(id);
			if (p) out.push(p);
		}
		frontier = next;
	}
	return out;
}
/** State before an event, as event IDs. */
async function stateBeforeEvent(hs, roomId, version, eventId) {
	const pdu = await hs.rooms.getPdu(eventId);
	if (!pdu || pdu.room_id !== roomId) throw errors.notFound("Unknown event");
	return (await hs.rooms.stateBefore(roomId, version, (pdu.prev_events ?? []).map(eventIdOf))).ids;
}
/** Build a membership template for make_join / make_leave / make_knock. */
async function makeMembership(hs, roomId, version, userId, membership, content = {}) {
	const state = await hs.rooms.currentState(roomId);
	const extremities = await hs.rooms.extremities(roomId);
	const prevs = [...(await hs.rooms.getPdus(extremities)).values()].sort((a, b) => b.depth - a.depth).slice(0, 10);
	const f = roomVersionFeatures(version);
	const draft = {
		type: M.ROOM.MEMBER,
		sender: userId,
		state_key: userId,
		content: {
			membership,
			...content
		}
	};
	const authIds = authEventKeys(draft, version).map((k) => state.get(k)?.event_id).filter((x) => !!x);
	const ref = (id, pdu) => f.legacyEventIds ? [id, pdu?.hashes ?? {}] : id;
	const authPdus = await hs.rooms.getPdus(authIds);
	const event = {
		type: M.ROOM.MEMBER,
		room_id: roomId,
		sender: userId,
		state_key: userId,
		content: draft.content,
		origin_server_ts: Date.now(),
		depth: Math.min(prevs.reduce((m, p) => Math.max(m, p.depth), 0) + 1, Number.MAX_SAFE_INTEGER),
		prev_events: prevs.map((p) => ref(p.event_id, p)),
		auth_events: authIds.map((id) => ref(id, authPdus.get(id)))
	};
	if (f.legacyEventIds) event.origin = domainOf(userId);
	const authState = new Map(state);
	try {
		checkAuth(event, authState, version, { joinAuthorisedSignatureValid: true });
	} catch (err) {
		throw err instanceof MatrixError ? err : errors.forbidden(String(err));
	}
	return event;
}
/** For restricted rooms: a local user who can authorise a remote join, or why not. */
async function restrictedAuthoriser(hs, state, version, userId) {
	const joinRules = getState(state, M.ROOM.JOIN_RULES)?.content;
	const rule = joinRules?.join_rule;
	const f = roomVersionFeatures(version);
	if (!(rule === "restricted" && f.restricted || rule === "knock_restricted" && f.knockRestricted)) return null;
	const current = membershipOf(state, userId);
	if (current === "join" || current === "invite") return null;
	let allowed = false;
	let unverifiable = false;
	for (const allow of Array.isArray(joinRules?.allow) ? joinRules.allow : []) {
		if (allow?.type !== M.ROOM_MEMBERSHIP || typeof allow.room_id !== "string") continue;
		if (!await hs.rooms.serverIsJoined(allow.room_id)) {
			unverifiable = true;
			continue;
		}
		if (await hs.rooms.membership(allow.room_id, userId) === "join") {
			allowed = true;
			break;
		}
	}
	if (!allowed) {
		if (unverifiable) throw new MatrixError(400, "M_UNABLE_TO_AUTHORISE_JOIN", "Unable to verify the join conditions for this user");
		throw errors.forbidden("You do not satisfy the room's join conditions");
	}
	const pl = powerLevels(state, version);
	for (const [key, ev] of state) {
		const [type, member] = splitStateKey(key);
		if (type === M.ROOM.MEMBER && hs.isLocalUser(member) && ev.content?.membership === "join" && userLevel(pl, member) >= pl.invite) return member;
	}
	throw new MatrixError(400, "M_UNABLE_TO_GRANT_JOIN", "No local user can authorise this join");
}
/** Shared send_join / send_leave / send_knock processing. */
/** Send the invite an m.room.third_party_invite stands for, on behalf of its (local) sender. */
async function exchangeThirdPartyInvite(hs, roomId, sender, invitee, signed) {
	const token = signed.token;
	if (typeof token !== "string") throw errors.badJson("signed.token is required");
	const pending = getState(await hs.rooms.currentState(roomId), M.ROOM.THIRD_PARTY_INVITE, token);
	if (!pending) throw errors.forbidden("No such third-party invite");
	if (pending.sender !== sender) throw errors.forbidden("The third-party invite was sent by someone else");
	await hs.membership.invite(roomId, sender, invitee, { thirdPartyInvite: {
		display_name: stringOrUndefined(pending.content?.display_name) ?? "",
		signed
	} });
}
async function sendMembership(ctx, origin, membership) {
	const hs = ctx.hs;
	const roomId = ctx.params.roomId;
	const version = await roomOr404(hs, roomId);
	await checkAcl(hs, roomId, origin);
	const raw = await ctx.json();
	if (!isPdu(raw) || raw.type !== M.ROOM.MEMBER || raw.content.membership !== membership || raw.state_key !== raw.sender) throw errors.badJson(`Expected a ${membership} event`);
	if (domainOf(raw.sender) !== origin) throw errors.forbidden("Sender does not belong to the origin server");
	let { pdu, joinAuthorisedSignatureValid } = await hs.federation.verifyPdu(raw, version, roomId);
	if (pdu.event_id !== ctx.params.eventId) throw errors.badJson("Event ID mismatch");
	if (membership === "knock" && !roomVersionFeatures(version).knock) throw new MatrixError(400, "M_INCOMPATIBLE_ROOM_VERSION", "Knocking is not supported", { room_version: version });
	const via = pdu.content?.join_authorised_via_users_server;
	if (membership === "join" && typeof via === "string" && hs.isLocalUser(via)) {
		const redacted = signJson(redact({ ...raw }, version), hs.serverName, hs.signingKey);
		pdu = {
			...pdu,
			signatures: {
				...pdu.signatures,
				[hs.serverName]: redacted.signatures[hs.serverName]
			}
		};
		raw.signatures = pdu.signatures;
		joinAuthorisedSignatureValid = true;
	}
	const stateBefore = await hs.rooms.withLock(roomId, async () => {
		const before = await hs.rooms.currentStateIds(roomId);
		const result = await hs.rooms.persistEvent(roomId, version, pdu, { joinAuthorisedSignatureValid });
		if (result.status === "rejected") throw errors.forbidden(result.reason ?? "Event not allowed");
		return before;
	});
	const others = hs.federation.serversInRoom(await hs.rooms.currentState(roomId));
	others.delete(origin);
	if (others.size) await hs.federation.sender.sendPdu(others, hs.federation.toFederationPdu(pdu, version));
	return {
		pdu,
		stateBefore,
		version
	};
}
function registerFederationRoutes(r) {
	const fed = (method, path, def) => {
		r.add(method, `${F}${path}`, procedure({
			input: def.input,
			guard: async (ctx) => ({ origin: await authenticate(ctx) }),
			handler: (ctx) => def.handler(ctx, ctx.origin)
		}));
	};
	const notary = async (ctx, servers) => {
		const out = [];
		for (const server of servers) {
			if (server === ctx.hs.serverName) {
				const key = ctx.hs.signingKey;
				out.push(signJson({
					server_name: ctx.hs.serverName,
					valid_until_ts: Date.now() + 864e5,
					verify_keys: { [`ed25519:${key.keyId}`]: { key: key.publicKeyBase64 } },
					old_verify_keys: {}
				}, ctx.hs.serverName, key));
				continue;
			}
			try {
				const fresh = await ctx.hs.federation.client.request(server, "GET", "/_matrix/key/v2/server", {
					signed: false,
					timeoutMs: 1e4
				});
				if (await ctx.hs.federation.keyring.ingestServerKeys(server, fresh)) out.push(signJson(fresh, ctx.hs.serverName, ctx.hs.signingKey));
			} catch {}
		}
		return { server_keys: out };
	};
	const requireFederation = (ctx) => {
		if (!ctx.hs.federation.enabled) throw errors.unrecognized("Federation is disabled");
	};
	r.post("/_matrix/key/v2/query", procedure({
		input: keyQueryBody,
		handler: async (ctx) => {
			requireFederation(ctx);
			return canonicalJsonResponse(await notary(ctx, Object.keys(ctx.input.server_keys ?? {})));
		}
	}));
	r.get("/_matrix/key/v2/query/:serverName", procedure({ handler: async (ctx) => {
		requireFederation(ctx);
		return canonicalJsonResponse(await notary(ctx, [ctx.params.serverName]));
	} }));
	fed("PUT", "/v1/send/:txnId", { handler: async (ctx, origin) => {
		const body = await ctx.json();
		if (body.origin !== void 0 && body.origin !== origin) throw errors.forbidden("Transaction origin mismatch");
		return ctx.hs.federation.receiveTransaction(origin, ctx.params.txnId, body);
	} });
	fed("GET", "/v1/make_join/:roomId/:userId", { handler: async (ctx, origin) => {
		const hs = ctx.hs;
		const { roomId, userId } = ctx.params;
		if (domainOf(userId) !== origin) throw errors.forbidden("User does not belong to the origin server");
		const version = await roomOr404(hs, roomId);
		await rejectIfPartial(hs, roomId);
		const supported = ctx.query.getAll("ver");
		if (!(supported.length ? supported : ["1"]).includes(version)) throw new MatrixError(400, "M_INCOMPATIBLE_ROOM_VERSION", "Your server does not support this room version", { room_version: version });
		const state = await checkAcl(hs, roomId, origin);
		if (FederationJoinGuard.noLocalMembers(hs, state)) throw errors.notFound("This server is not in the room");
		const via = await restrictedAuthoriser(hs, state, version, userId);
		return {
			event: await makeMembership(hs, roomId, version, userId, "join", via ? { join_authorised_via_users_server: via } : {}),
			room_version: version
		};
	} });
	const sendJoin = async (ctx, origin) => {
		const hs = ctx.hs;
		await rejectIfPartial(hs, ctx.params.roomId);
		const { pdu, stateBefore, version } = await sendMembership(ctx, origin, "join");
		const statePdus = [...(await hs.rooms.getPdus(Object.values(stateBefore))).values()];
		const chain = await authChainOf(hs, [...Object.values(stateBefore), pdu.event_id]);
		const toWire = (p) => hs.federation.toFederationPdu(p, version);
		const servers = [.../* @__PURE__ */ new Set([hs.serverName, ...hs.federation.serversInRoom(await hs.rooms.currentState(ctx.params.roomId))])];
		return {
			origin: hs.serverName,
			event: toWire(pdu),
			state: statePdus.map(toWire),
			auth_chain: chain.map(toWire),
			members_omitted: false,
			servers_in_room: servers
		};
	};
	fed("PUT", "/v2/send_join/:roomId/:eventId", { handler: sendJoin });
	fed("PUT", "/v1/send_join/:roomId/:eventId", { handler: async (ctx, origin) => [200, await sendJoin(ctx, origin)] });
	fed("GET", "/v1/make_leave/:roomId/:userId", { handler: async (ctx, origin) => {
		const { roomId, userId } = ctx.params;
		if (domainOf(userId) !== origin) throw errors.forbidden("User does not belong to the origin server");
		const version = await roomOr404(ctx.hs, roomId);
		await checkAcl(ctx.hs, roomId, origin);
		return {
			event: await makeMembership(ctx.hs, roomId, version, userId, "leave"),
			room_version: version
		};
	} });
	fed("PUT", "/v2/send_leave/:roomId/:eventId", { handler: async (ctx, origin) => {
		await sendMembership(ctx, origin, "leave");
		return {};
	} });
	fed("PUT", "/v1/send_leave/:roomId/:eventId", { handler: async (ctx, origin) => {
		await sendMembership(ctx, origin, "leave");
		return [200, {}];
	} });
	fed("GET", "/v1/make_knock/:roomId/:userId", { handler: async (ctx, origin) => {
		const { roomId, userId } = ctx.params;
		if (domainOf(userId) !== origin) throw errors.forbidden("User does not belong to the origin server");
		const version = await roomOr404(ctx.hs, roomId);
		await rejectIfPartial(ctx.hs, roomId);
		const supported = ctx.query.getAll("ver");
		if (!(supported.length ? supported : ["1"]).includes(version) || !roomVersionFeatures(version).knock) throw new MatrixError(400, "M_INCOMPATIBLE_ROOM_VERSION", "Your server does not support this room version", { room_version: version });
		await checkAcl(ctx.hs, roomId, origin);
		return {
			event: await makeMembership(ctx.hs, roomId, version, userId, "knock"),
			room_version: version
		};
	} });
	fed("PUT", "/v1/send_knock/:roomId/:eventId", { handler: async (ctx, origin) => {
		await rejectIfPartial(ctx.hs, ctx.params.roomId);
		await sendMembership(ctx, origin, "knock");
		return { knock_room_state: ctx.hs.rooms.strippedState(await ctx.hs.rooms.currentState(ctx.params.roomId)) };
	} });
	const invite = async (ctx, origin, v2) => {
		const hs = ctx.hs;
		const body = await ctx.json();
		const raw = v2 ? body.event : body;
		const version = v2 ? String(body.room_version ?? "1") : "1";
		if (!SUPPORTED_ROOM_VERSIONS.includes(version)) throw new MatrixError(400, "M_INCOMPATIBLE_ROOM_VERSION", "Unsupported room version", { room_version: version });
		if (!isPdu(raw) || raw.type !== M.ROOM.MEMBER || raw.content.membership !== "invite" || typeof raw.state_key !== "string") throw errors.badJson("Expected an invite event");
		if (raw.room_id !== ctx.params.roomId) throw errors.badJson("Room ID mismatch");
		if (domainOf(raw.sender) !== origin) throw errors.forbidden("Sender does not belong to the origin server");
		const target = raw.state_key;
		if (!hs.isLocalUser(target)) throw errors.forbidden("User is not local");
		const user = await hs.db.findOne("users", [{
			field: "user_id",
			value: target
		}]);
		if (!user || user.deactivated) throw errors.notFound("Unknown user");
		if (await hs.rooms.exists(raw.room_id)) await checkAcl(hs, raw.room_id, origin);
		const { pdu } = await hs.federation.verifyPdu(raw, version, raw.room_id);
		if (pdu.event_id !== ctx.params.eventId) throw errors.badJson("Event ID mismatch");
		if (await inviteDecision(hs, target, raw.sender) === "block") throw errors.inviteBlocked();
		const ignored = await hs.db.findOne("account_data", [
			{
				field: "user_id",
				value: target
			},
			{
				field: "room_id",
				value: ""
			},
			{
				field: "type",
				value: M.IGNORED_USER_LIST
			}
		]);
		const signedRedacted = signJson(redact({ ...raw }, version), hs.serverName, hs.signingKey);
		const signatures = {
			...pdu.signatures,
			[hs.serverName]: signedRedacted.signatures[hs.serverName]
		};
		const inviteState = Array.isArray(body.invite_room_state) ? body.invite_room_state : Array.isArray(raw.unsigned?.invite_room_state) ? raw.unsigned.invite_room_state : [];
		const createInState = inviteState.find((e) => isObject(e) && e.type === M.ROOM.CREATE);
		if (v2 && !createInState && roomVersionFeatures(version).v12) throw errors.missingParam("invite_room_state must include the m.room.create event");
		if (createInState && roomVersionFeatures(version).v12 && createInState.event_id === void 0) try {
			if (hs.federation.computeEventId(createInState, version) !== `$${raw.room_id.slice(1)}`) throw new Error("mismatch");
		} catch {
			throw errors.invalidParam("invite_room_state contains a create event for another room");
		}
		const stored = {
			...pdu,
			signatures,
			unsigned: {
				...pdu.unsigned,
				invite_room_state: inviteState
			}
		};
		if (!ignored?.content?.ignored_users?.[raw.sender]) await hs.rooms.recordRemoteMembership(stored, version);
		const wire = hs.federation.toFederationPdu({
			...pdu,
			signatures
		}, version);
		return v2 ? { event: wire } : [200, { event: wire }];
	};
	fed("PUT", "/v2/invite/:roomId/:eventId", { handler: (ctx, origin) => invite(ctx, origin, true) });
	fed("PUT", "/v1/invite/:roomId/:eventId", { handler: (ctx, origin) => invite(ctx, origin, false) });
	fed("GET", "/v1/event/:eventId", { handler: async (ctx, origin) => {
		const hs = ctx.hs;
		const ev = await hs.rooms.getEvent(ctx.params.eventId);
		const pdu = ev?.pdu ?? await hs.rooms.getPdu(ctx.params.eventId);
		if (!pdu) throw errors.notFound("Unknown event");
		const version = await roomOr404(hs, pdu.room_id);
		await checkAcl(hs, pdu.room_id, origin);
		if (ev && !await serverCanSee(hs, origin, ev)) throw errors.forbidden("You may not see this event");
		return {
			origin: hs.serverName,
			origin_server_ts: Date.now(),
			pdus: [hs.federation.toFederationPdu(pdu, version)]
		};
	} });
	const stateHandler = (idsOnly) => async (ctx, origin) => {
		const hs = ctx.hs;
		const roomId = ctx.params.roomId;
		const version = await roomOr404(hs, roomId);
		if (await hs.partialState.isPartial(roomId)) throw errors.forbidden("This server only has partial state for the room");
		const state = await checkAcl(hs, roomId, origin);
		if (!FederationJoinGuard.serverInRoom(state, origin)) throw errors.forbidden("Your server is not in the room");
		const eventId = ctx.query.get("event_id");
		if (!eventId) throw errors.missingParam("Missing event_id");
		const before = await stateBeforeEvent(hs, roomId, version, eventId);
		const chain = await authChainOf(hs, Object.values(before));
		if (idsOnly) return {
			pdu_ids: Object.values(before),
			auth_chain_ids: chain.map((p) => p.event_id)
		};
		return {
			pdus: [...(await hs.rooms.getPdus(Object.values(before))).values()].map((p) => hs.federation.toFederationPdu(p, version)),
			auth_chain: chain.map((p) => hs.federation.toFederationPdu(p, version))
		};
	};
	fed("GET", "/v1/state/:roomId", { handler: stateHandler(false) });
	fed("GET", "/v1/state_ids/:roomId", { handler: stateHandler(true) });
	fed("GET", "/v1/event_auth/:roomId/:eventId", { handler: async (ctx, origin) => {
		const hs = ctx.hs;
		const version = await roomOr404(hs, ctx.params.roomId);
		await checkAcl(hs, ctx.params.roomId, origin);
		if (!await eventInRoom(hs, ctx.params.roomId, ctx.params.eventId)) throw errors.notFound("Event not found");
		return { auth_chain: (await authChainOf(hs, [ctx.params.eventId])).map((p) => hs.federation.toFederationPdu(p, version)) };
	} });
	fed("GET", "/v1/backfill/:roomId", { handler: async (ctx, origin) => {
		const hs = ctx.hs;
		const roomId = ctx.params.roomId;
		const version = await roomOr404(hs, roomId);
		const state = await checkAcl(hs, roomId, origin);
		if (!FederationJoinGuard.serverInRoom(state, origin)) throw errors.forbidden("Your server is not in the room");
		const limit = Math.min(Math.max(Number(ctx.query.get("limit") ?? 10) || 10, 1), 100);
		const out = [];
		const seen = /* @__PURE__ */ new Set();
		let frontier = ctx.query.getAll("v");
		while (frontier.length && out.length < limit) {
			const next = [];
			for (const id of frontier) {
				if (seen.has(id) || out.length >= limit) continue;
				seen.add(id);
				const ev = await hs.rooms.getEvent(id);
				if (!ev || ev.pdu.room_id !== roomId) continue;
				out.push(await serverCanSee(hs, origin, ev) ? ev.pdu : redactPdu(ev.pdu, version));
				next.push(...(ev.pdu.prev_events ?? []).map(eventIdOf));
			}
			frontier = next;
		}
		return {
			origin: hs.serverName,
			origin_server_ts: Date.now(),
			pdus: out.map((p) => hs.federation.toFederationPdu(p, version))
		};
	} });
	fed("POST", "/v1/get_missing_events/:roomId", {
		input: missingEventsBody,
		handler: async (ctx, origin) => {
			const hs = ctx.hs;
			const roomId = ctx.params.roomId;
			const version = await roomOr404(hs, roomId);
			const state = await checkAcl(hs, roomId, origin);
			if (!FederationJoinGuard.serverInRoom(state, origin)) throw errors.forbidden("Your server is not in the room");
			const body = ctx.input;
			const earliest = new Set(body.earliest_events ?? []);
			const limit = Math.min(Number(body.limit ?? 10) || 10, 100);
			const minDepth = Number(body.min_depth ?? 0) || 0;
			const out = [];
			const seen = new Set(body.latest_events ?? []);
			let frontier = [];
			for (const id of seen) {
				const ev = await eventInRoom(hs, roomId, id);
				if (ev) frontier.push(...(ev.pdu.prev_events ?? []).map(eventIdOf));
			}
			while (frontier.length && out.length < limit) {
				const next = [];
				for (const id of frontier) {
					if (seen.has(id) || earliest.has(id) || out.length >= limit) continue;
					seen.add(id);
					const ev = await eventInRoom(hs, roomId, id);
					if (!ev || ev.pdu.depth < minDepth) continue;
					out.push(await serverCanSee(hs, origin, ev) ? ev.pdu : redactPdu(ev.pdu, version));
					next.push(...(ev.pdu.prev_events ?? []).map(eventIdOf));
				}
				frontier = next;
			}
			out.sort((a, b) => a.depth - b.depth);
			return { events: out.map((p) => hs.federation.toFederationPdu(p, version)) };
		}
	});
	fed("GET", "/v1/timestamp_to_event/:roomId", { handler: async (ctx, origin) => {
		const hs = ctx.hs;
		const roomId = ctx.params.roomId;
		await roomOr404(hs, roomId);
		await checkAcl(hs, roomId, origin);
		const ts = Number(ctx.query.get("ts"));
		const dir = ctx.query.get("dir");
		if (!Number.isFinite(ts) || dir !== "f" && dir !== "b") throw errors.invalidParam("Invalid ts or dir");
		for (const row of await eventsByTimestamp(hs, roomId, dir)) {
			const t = row.json.origin_server_ts;
			if (dir === "f" ? t >= ts : t <= ts) return {
				event_id: row.event_id,
				origin_server_ts: t
			};
		}
		throw errors.notFound("No event found");
	} });
	fed("GET", "/v1/query/directory", { handler: async (ctx) => {
		const alias = ctx.query.get("room_alias");
		if (!alias) throw errors.missingParam("Missing room_alias");
		const row = await ctx.hs.db.findOne("room_aliases", [{
			field: "alias",
			value: alias
		}]);
		if (!row) throw errors.notFound("Room alias not found");
		const servers = [ctx.hs.serverName, ...ctx.hs.federation.serversInRoom(await ctx.hs.rooms.currentState(row.room_id))];
		return {
			room_id: row.room_id,
			servers: [...new Set(servers)]
		};
	} });
	fed("GET", "/v1/query/profile", { handler: async (ctx) => {
		const userId = ctx.query.get("user_id");
		if (!userId) throw errors.missingParam("Missing user_id");
		if (!isValidUserId(userId)) throw errors.invalidParam("Invalid user ID");
		if (!ctx.hs.isLocalUser(userId)) throw errors.notFound("Unknown user");
		const profile = await fullProfile(ctx.hs, userId);
		if (!profile) throw errors.notFound("Unknown user");
		const field = ctx.query.get("field");
		if (!field) return profile;
		if (profile[field] === void 0) throw errors.notFound("Profile field not set");
		return { [field]: profile[field] };
	} });
	fed("POST", "/unstable/event_relationships", {
		input: body({}),
		handler: async (ctx, origin) => relationshipsForServer(ctx.hs, origin, ctx.input, (ids) => authChainOf(ctx.hs, ids))
	});
	fed("POST", "/v1/user/keys/query", {
		input: userKeysQueryBody,
		handler: async (ctx) => {
			const local = {};
			for (const [userId, devices] of Object.entries(ctx.input.device_keys ?? {})) if (ctx.hs.isLocalUser(userId)) local[userId] = Array.isArray(devices) ? devices : [];
			const res = await ctx.hs.keys.query("", local);
			return {
				device_keys: res.device_keys,
				master_keys: res.master_keys,
				self_signing_keys: res.self_signing_keys
			};
		}
	});
	fed("POST", "/v1/user/keys/claim", {
		input: userKeysClaimBody,
		handler: async (ctx) => {
			const local = {};
			for (const [userId, devices] of Object.entries(ctx.input.one_time_keys ?? {})) if (ctx.hs.isLocalUser(userId) && isObject(devices)) local[userId] = devices;
			return { one_time_keys: await ctx.hs.keys.claim(local) };
		}
	});
	fed("GET", "/v1/user/devices/:userId", { handler: async (ctx) => {
		const hs = ctx.hs;
		const userId = ctx.params.userId;
		if (!hs.isLocalUser(userId)) throw errors.forbidden("User is not local");
		const devices = await hs.db.findMany("devices", { where: [{
			field: "user_id",
			value: userId
		}] });
		const keys = await hs.keys.query("", { [userId]: [] });
		const out = {
			user_id: userId,
			stream_id: (await hs.db.findOne("device_list_changes", [{
				field: "user_id",
				value: userId
			}]))?.stream ?? 0,
			devices: devices.map((d) => ({
				device_id: d.device_id,
				keys: keys.device_keys[userId]?.[d.device_id],
				...d.display_name ? { device_display_name: d.display_name } : {}
			}))
		};
		if (keys.master_keys[userId]) out.master_key = keys.master_keys[userId];
		if (keys.self_signing_keys[userId]) out.self_signing_key = keys.self_signing_keys[userId];
		return out;
	} });
	const publicRooms = async (ctx) => {
		const hs = ctx.hs;
		const body = (ctx.method === "POST" ? ctx.input : void 0) ?? {};
		const limit = Number(body.limit ?? ctx.query.get("limit") ?? 0) || void 0;
		const rooms = await hs.db.findMany("rooms", { where: [{
			field: "is_public",
			value: true
		}] });
		let chunk = await Promise.all(rooms.map((r) => roomDetails(hs, r.room_id)));
		const term = isObject(body.filter) && typeof body.filter.generic_search_term === "string" ? body.filter.generic_search_term.toLowerCase() : null;
		if (term) chunk = chunk.filter((c) => [
			c.name,
			c.topic,
			c.canonical_alias
		].some((v) => typeof v === "string" && v.toLowerCase().includes(term)));
		chunk.sort((a, b) => b.num_joined_members - a.num_joined_members);
		const since = Number.parseInt(String(body.since ?? ctx.query.get("since") ?? "0").replace(/^o/, ""), 10) || 0;
		const out = {
			chunk: limit ? chunk.slice(since, since + limit) : chunk.slice(since),
			total_room_count_estimate: chunk.length
		};
		if (limit && since + limit < chunk.length) out.next_batch = `o${since + limit}`;
		return out;
	};
	fed("GET", "/v1/publicRooms", { handler: (ctx) => publicRooms(ctx) });
	fed("POST", "/v1/publicRooms", {
		input: publicRoomsBody,
		handler: (ctx) => publicRooms(ctx)
	});
	fed("GET", "/v1/hierarchy/:roomId", { handler: async (ctx, origin) => {
		const hs = ctx.hs;
		const roomId = ctx.params.roomId;
		await roomOr404(hs, roomId);
		const state = await checkAcl(hs, roomId, origin);
		const suggestedOnly = ctx.query.get("suggested_only") === "true";
		const summary = async (id, s) => {
			const allowed = allowedRoomIds(getState(s, M.ROOM.JOIN_RULES)?.content);
			return {
				...await roomDetails(hs, id),
				...allowed ? { allowed_room_ids: allowed } : {}
			};
		};
		const accessible = async (s) => {
			const jr = getState(s, M.ROOM.JOIN_RULES)?.content;
			const rule = stringOrUndefined(jr?.join_rule) ?? "invite";
			const hv = getState(s, M.ROOM.HISTORY_VISIBILITY)?.content?.history_visibility;
			if ([
				"public",
				"knock",
				"knock_restricted"
			].includes(rule) || hv === "world_readable" || FederationJoinGuard.serverInRoom(s, origin)) return true;
			if (rule !== "restricted") return false;
			for (const allow of Array.isArray(jr?.allow) ? jr.allow : []) {
				if (allow?.type !== M.ROOM_MEMBERSHIP || typeof allow.room_id !== "string" || !await hs.rooms.exists(allow.room_id)) continue;
				if (FederationJoinGuard.serverInRoom(await hs.rooms.currentState(allow.room_id), origin)) return true;
			}
			return false;
		};
		if (!await accessible(state)) throw errors.notFound("Room is not accessible");
		const children = [];
		const childrenState = [];
		const inaccessible = [];
		for (const [key, ev] of state) {
			const [type, childId] = splitStateKey(key);
			if (type !== M.SPACE.CHILD || !Array.isArray(ev.content?.via) || !ev.content.via.length) continue;
			if (suggestedOnly && ev.content.suggested !== true) continue;
			childrenState.push({
				type,
				state_key: childId,
				sender: ev.sender,
				content: ev.content,
				origin_server_ts: ev.origin_server_ts
			});
			if (!await hs.rooms.exists(childId)) continue;
			const childState = await hs.rooms.currentState(childId);
			if (!await accessible(childState)) {
				inaccessible.push(childId);
				continue;
			}
			children.push({
				...await summary(childId, childState),
				children_state: []
			});
		}
		return {
			room: {
				...await summary(roomId, state),
				children_state: childrenState
			},
			children,
			inaccessible_children: inaccessible
		};
	} });
	const mediaHandler = async (ctx) => {
		const hs = ctx.hs;
		const meta = await hs.db.findOne("media", [{
			field: "media_id",
			value: ctx.params.mediaId
		}]);
		if (!meta || meta.pending) throw errors.notFound("Media not found");
		const data = await hs.media.get(ctx.params.mediaId);
		if (!data) throw errors.notFound("Media not found");
		const boundary = randomToken(16);
		const head = `--${boundary}\r\nContent-Type: application/json\r\n\r\n{}\r\n--${boundary}\r\nContent-Type: ${meta.content_type ?? "application/octet-stream"}\r\n` + (meta.filename ? `Content-Disposition: attachment; filename*=utf-8''${encodeURIComponent(meta.filename)}\r\n` : "") + "\r\n";
		const body = Buffer.concat([
			Buffer.from(head),
			Buffer.from(data),
			Buffer.from(`\r\n--${boundary}--\r\n`)
		]);
		return new Response(body, {
			status: 200,
			headers: { "content-type": `multipart/mixed; boundary=${boundary}` }
		});
	};
	fed("GET", "/v1/media/download/:mediaId", { handler: (ctx) => mediaHandler(ctx) });
	fed("GET", "/v1/media/thumbnail/:mediaId", { handler: (ctx) => mediaHandler(ctx) });
	r.get(`${F}/v1/openid/userinfo`, procedure({ handler: async (ctx) => {
		const token = ctx.query.get("access_token");
		const userId = token ? await ctx.hs.cluster.get(`openid:${token}`) : null;
		if (!userId) throw new MatrixError(401, "M_UNKNOWN_TOKEN", "Invalid OpenID token");
		return { sub: userId };
	} }));
	r.client("POST", "/user/:userId/openid/request_token", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			if (ctx.params.userId !== s.userId) throw errors.forbidden("Cannot request tokens for other users");
			const token = randomToken();
			await ctx.hs.cluster.set(`openid:${token}`, s.userId, 36e5);
			return {
				access_token: token,
				token_type: "Bearer",
				matrix_server_name: ctx.hs.serverName,
				expires_in: 3600
			};
		}
	}));
	fed("PUT", "/v1/exchange_third_party_invite/:roomId", { handler: async (ctx, origin) => {
		const hs = ctx.hs;
		const roomId = ctx.params.roomId;
		const event = await ctx.json();
		const invite = isObject(event.content) ? event.content.third_party_invite : void 0;
		const signed = isObject(invite) ? invite.signed : void 0;
		if (!isPdu(event) || event.type !== M.ROOM.MEMBER || event.room_id !== roomId || event.content.membership !== "invite" || !isObject(signed)) throw errors.badJson("Expected an m.room.member invite with third_party_invite");
		if (typeof event.sender !== "string" || !hs.isLocalUser(event.sender)) throw errors.forbidden("The sender is not a user of this server");
		if (typeof event.state_key !== "string" || domainOf(event.state_key) !== origin || signed.mxid !== event.state_key) throw errors.forbidden("The invitee does not belong to the requesting server");
		await roomOr404(hs, roomId);
		await checkAcl(hs, roomId, origin);
		await exchangeThirdPartyInvite(hs, roomId, event.sender, event.state_key, signed);
		return {};
	} });
	r.put(`${F}/v1/3pid/onbind`, procedure({ handler: async (ctx) => {
		const hs = ctx.hs;
		const body = await ctx.json();
		const invites = Array.isArray(body.invites) ? body.invites : [];
		for (const invite of invites) {
			if (!isObject(invite)) continue;
			const signed = invite.signed;
			if (!isObject(signed) || typeof signed.mxid !== "string" || !hs.isLocalUser(signed.mxid)) continue;
			if (typeof invite.room_id !== "string" || typeof invite.sender !== "string") continue;
			const event = {
				type: M.ROOM.MEMBER,
				room_id: invite.room_id,
				sender: invite.sender,
				state_key: signed.mxid,
				content: {
					membership: "invite",
					third_party_invite: { signed }
				}
			};
			try {
				if (hs.isLocalUser(invite.sender)) await exchangeThirdPartyInvite(hs, invite.room_id, invite.sender, signed.mxid, signed);
				else await hs.federation.client.request(domainOf(invite.sender), "PUT", `/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(invite.room_id)}`, { body: event });
			} catch (err) {
				hs.logger.warn("Could not exchange third-party invite to", invite.room_id, "for", signed.mxid, err);
			}
		}
		return {};
	} }));
}
/** Helpers for "is a server in the room" checks. */
const FederationJoinGuard = {
	serverInRoom(state, server) {
		for (const [key, ev] of state) {
			const [type, userId] = splitStateKey(key);
			if (type === M.ROOM.MEMBER && domainOf(userId) === server && ev.content?.membership === "join") return true;
		}
		return false;
	},
	noLocalMembers(hs, state) {
		for (const [key, ev] of state) {
			const [type, userId] = splitStateKey(key);
			if (type === M.ROOM.MEMBER && hs.isLocalUser(userId) && ev.content?.membership === "join") return false;
		}
		return true;
	}
};
export { registerFederationRoutes };

//# sourceMappingURL=federation.js.map