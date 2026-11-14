import { isObject } from "../packages/shared/src/json.js";
import { isValidAlias, isValidRoomId, isValidUserId } from "../packages/shared/src/ids.js";
import { M, UNSTABLE } from "../packages/shared/src/m.js";
import { MatrixError, errors } from "../core/errors.js";
import { getState, ownerOfStateKey, powerLevels, roomCreators, userLevel } from "../core/authrules.js";
import { validatePowerLevelContent } from "../core/rooms.js";
import { SUPPORTED_ROOM_VERSIONS, previousMembership, roomVersionFeatures, splitStateKey, toClientEvent } from "../core/events.js";
import { assertNotSuspended } from "../core/auth.js";
import { procedure } from "../http/procedure.js";
import { inviteDecision } from "../core/invitefilter.js";
import { v } from "../core/vpm.js";
import { body, fail } from "../http/input.js";
// src/api/rooms.ts
const parseToken = (token) => {
	if (token === null || token === "") return null;
	const m = /^[st]?(\d+)/.exec(token);
	if (!m) throw errors.invalidParam("Invalid pagination token");
	return Number(m[1]);
};
const viewerOf = (s) => ({
	userId: s.userId,
	deviceId: s.deviceId
});
async function requireRoom(hs, roomId) {
	if (!isValidRoomId(roomId)) throw errors.invalidParam("Invalid room ID");
	const version = await hs.rooms.roomVersion(roomId);
	if (!version) throw errors.forbidden("Room not found or you are not a member");
	return version;
}
/**
* State visible to the user: current state when joined (or world readable),
* otherwise the state at the moment they left.
*/
async function visibleState(hs, roomId, userId) {
	await requireRoom(hs, roomId);
	const { joined, worldReadable, membership } = await hs.rooms.canPeek(roomId, userId);
	if (joined || worldReadable) return hs.rooms.currentState(roomId);
	if ((await hs.db.findOne("memberships", [{
		field: "room_id",
		value: roomId
	}, {
		field: "user_id",
		value: userId
	}]))?.forgotten) throw errors.forbidden("You have forgotten this room");
	if (membership === "leave" || membership === "ban") {
		const ev = await hs.rooms.membershipEvent(roomId, userId);
		if (ev && ev.pdu.sender !== void 0) {
			if (previousMembership(ev.pdu) === "join" || membership === "ban") return hs.rooms.stateAtSnapshot(ev.snapshot);
		}
	}
	throw errors.forbidden("You are not a member of this room");
}
async function ownEvent(hs, userId, eventId) {
	return typeof eventId === "string" && (await hs.rooms.getPdu(eventId))?.sender === userId;
}
async function validateStateEvent(hs, roomId, type, content, stateKeyValue = "") {
	if (type === M.ROOM.CREATE) throw errors.badJson("The create event cannot be sent");
	if (stateKeyValue.startsWith("@") && roomVersionFeatures(await hs.rooms.roomVersion(roomId)).ownedState && !ownerOfStateKey(stateKeyValue)) throw errors.badJson("Malformed user-owned state key");
	if (type === M.ROOM.POWER_LEVELS) {
		const version = await hs.rooms.roomVersion(roomId);
		validatePowerLevelContent(content, roomCreators(await hs.rooms.currentState(roomId), version));
	}
	if (type === M.ROOM.CANONICAL_ALIAS) {
		const alt = Array.isArray(content.alt_aliases) ? content.alt_aliases : [];
		const aliases = [content.alias, ...alt].filter((a) => a !== void 0 && a !== null);
		if (content.alt_aliases !== void 0 && !Array.isArray(content.alt_aliases)) throw new MatrixError(400, "M_INVALID_PARAM", "alt_aliases must be a list");
		for (const alias of aliases) {
			if (!isValidAlias(alias)) throw new MatrixError(400, "M_INVALID_PARAM", "Invalid alias");
			const row = await hs.db.findOne("room_aliases", [{
				field: "alias",
				value: alias
			}]);
			if (!row || row.room_id !== roomId) throw new MatrixError(400, "M_BAD_ALIAS", `Alias ${alias} does not point to this room`);
		}
	}
}
async function upgradeRoom(hs, s, roomId, newVersion, additionalCreators) {
	if (!SUPPORTED_ROOM_VERSIONS.includes(newVersion)) throw errors.unsupportedRoomVersion();
	const version = await requireRoom(hs, roomId);
	const state = await hs.rooms.requireJoined(roomId, s.userId);
	const pl = powerLevels(state, version);
	const tombstoneLevel = pl.events[M.ROOM.TOMBSTONE] ?? pl.state_default;
	if (userLevel(pl, s.userId) < tombstoneLevel) throw errors.forbidden("You cannot upgrade this room");
	const create = getState(state, M.ROOM.CREATE);
	const creationContent = {};
	for (const k of [M.FEDERATE, "type"]) if (create.content[k] !== void 0) creationContent[k] = create.content[k];
	const toV12 = roomVersionFeatures(newVersion).v12;
	if (toV12) {
		creationContent.predecessor = { room_id: roomId };
		if (additionalCreators !== void 0) creationContent.additional_creators = additionalCreators;
	} else creationContent.predecessor = {
		room_id: roomId,
		event_id: (await hs.db.findMany("events", {
			where: [{
				field: "room_id",
				value: roomId
			}],
			sortBy: {
				field: "stream",
				direction: "desc"
			},
			limit: 1
		}))[0].event_id
	};
	const initialState = [
		M.ROOM.SERVER_ACL,
		M.ROOM.ENCRYPTION,
		M.ROOM.NAME,
		M.ROOM.AVATAR,
		M.ROOM.TOPIC,
		M.ROOM.GUEST_ACCESS,
		M.ROOM.HISTORY_VISIBILITY,
		M.ROOM.JOIN_RULES,
		M.ROOM.POWER_LEVELS
	].flatMap((t) => {
		const ev = getState(state, t);
		return ev && t !== M.ROOM.POWER_LEVELS ? [{
			type: t,
			state_key: "",
			content: ev.content
		}] : [];
	});
	const plContent = structuredClone(getState(state, M.ROOM.POWER_LEVELS)?.content ?? {});
	const oldUsers = isObject(plContent.users) ? plContent.users : {};
	const isPublic = (await hs.db.findOne("rooms", [{
		field: "room_id",
		value: roomId
	}]))?.is_public;
	const extra = Array.isArray(additionalCreators) ? additionalCreators : [];
	const creators = /* @__PURE__ */ new Set([s.userId, ...extra]);
	const oldPl = toV12 ? {
		...plContent,
		users: Object.fromEntries(Object.entries(oldUsers).filter(([u]) => !creators.has(u)))
	} : plContent;
	const level = userLevel(pl, s.userId);
	const override = toV12 ? oldPl : {
		...oldPl,
		users: {
			...oldUsers,
			[s.userId]: Number.isFinite(level) ? Math.max(level, 100) : 100
		}
	};
	const { room_id: newRoomId } = await hs.rooms.createRoom(s.userId, {
		room_version: newVersion,
		creation_content: creationContent,
		initial_state: initialState,
		power_level_content_override: override,
		preset: "private_chat",
		visibility: isPublic ? "public" : "private"
	});
	if (getState(state, M.ROOM.POWER_LEVELS) && !toV12) try {
		await hs.rooms.sendEvent(newRoomId, s.userId, {
			type: M.ROOM.POWER_LEVELS,
			state_key: "",
			content: oldPl
		});
	} catch {}
	const aliases = await hs.db.findMany("room_aliases", { where: [{
		field: "room_id",
		value: roomId
	}] });
	for (const a of aliases) await hs.db.update("room_aliases", [{
		field: "alias",
		value: a.alias
	}], { room_id: newRoomId });
	const canonical = getState(state, M.ROOM.CANONICAL_ALIAS);
	if (canonical && Object.keys(canonical.content).length) {
		await hs.rooms.sendEvent(roomId, s.userId, {
			type: M.ROOM.CANONICAL_ALIAS,
			state_key: "",
			content: {}
		}).catch((err) => hs.logger.warn("Room upgrade: removing the old room's canonical alias failed", err));
		await hs.rooms.sendEvent(newRoomId, s.userId, {
			type: M.ROOM.CANONICAL_ALIAS,
			state_key: "",
			content: canonical.content
		}).catch((err) => hs.logger.warn("Room upgrade: setting the new room's canonical alias failed", err));
	}
	if (isPublic) await hs.db.update("rooms", [{
		field: "room_id",
		value: roomId
	}], { is_public: false });
	await hs.rooms.sendEvent(roomId, s.userId, {
		type: M.ROOM.TOMBSTONE,
		state_key: "",
		content: {
			body: "This room has been replaced",
			replacement_room: newRoomId
		}
	});
	const restricted = {
		...oldPl,
		events_default: Math.max(50, pl.events_default),
		invite: Math.max(50, pl.invite)
	};
	await hs.rooms.sendEvent(roomId, s.userId, {
		type: M.ROOM.POWER_LEVELS,
		state_key: "",
		content: restricted
	}).catch((err) => hs.logger.warn("Room upgrade: restricting the old room's power levels failed", err));
	return newRoomId;
}
function registerRoomRoutes(r) {
	r.client("POST", "/createRoom", procedure({
		endpoint: "POST /v3/createRoom",
		auth: "user",
		input: body({}),
		handler: async (ctx) => {
			const s = ctx.session;
			if (s.isGuest) throw errors.forbidden("Guests cannot create rooms");
			await assertNotSuspended(ctx.hs, s);
			await ctx.rateLimit("createRoom");
			const created = await ctx.hs.rooms.createRoom(s.userId, ctx.input);
			await ctx.hs.audit.record({
				action: "room_create",
				actor: s.userId,
				target: created.room_id,
				ip: ctx.ip
			});
			return created;
		}
	}));
	r.client("GET", "/joined_rooms", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			return { joined_rooms: await ctx.hs.rooms.roomsForUser(s.userId) };
		}
	}));
	r.client("PUT", "/rooms/:roomId/send/:eventType/:txnId", procedure({
		endpoint: "PUT /v3/rooms/:roomId/send/:eventType/:txnId",
		auth: "user",
		rateLimit: "message",
		handler: async (ctx) => {
			const s = ctx.session;
			const content = await ctx.json();
			await requireRoom(ctx.hs, ctx.params.roomId);
			if (!(s.suspended && ctx.params.eventType === M.ROOM.REDACTION && await ownEvent(ctx.hs, s.userId, content?.redacts))) await assertNotSuspended(ctx.hs, s, ctx.params.roomId);
			const delay = ctx.query.get(UNSTABLE.ORG.MATRIX.MSC4140.DELAY);
			if (delay !== null) return { delay_id: await ctx.hs.delayedEvents.schedule({
				userId: s.userId,
				deviceId: s.deviceId,
				roomId: ctx.params.roomId,
				type: ctx.params.eventType,
				content,
				delayMs: Number(delay),
				txnId: ctx.params.txnId
			}) };
			const ts = s.appservice && ctx.query.get("ts") ? Number(ctx.query.get("ts")) : void 0;
			return { event_id: await ctx.hs.rooms.sendEvent(ctx.params.roomId, s.userId, {
				type: ctx.params.eventType,
				content
			}, {
				txnId: ctx.params.txnId,
				deviceId: s.deviceId || void 0,
				ts
			}) };
		}
	}));
	const putState = async (ctx) => {
		const s = await ctx.auth();
		const content = await ctx.json();
		const roomId = ctx.params.roomId;
		await requireRoom(ctx.hs, roomId);
		const type = ctx.params.eventType;
		const key = ctx.params.stateKey ?? "";
		if (!(type === M.ROOM.MEMBER && key === s.userId && content?.membership === "leave")) await assertNotSuspended(ctx.hs, s, roomId);
		await validateStateEvent(ctx.hs, roomId, type, content, key);
		if (type === M.ROOM.MEMBER && content?.membership === "invite" && ctx.hs.isLocalUser(key) && await inviteDecision(ctx.hs, key, s.userId) === "block") throw errors.inviteBlocked();
		const delay = ctx.query.get(UNSTABLE.ORG.MATRIX.MSC4140.DELAY);
		if (delay !== null) return { delay_id: await ctx.hs.delayedEvents.schedule({
			userId: s.userId,
			deviceId: s.deviceId,
			roomId,
			type,
			stateKey: key,
			content,
			delayMs: Number(delay)
		}) };
		const current = getState(await ctx.hs.rooms.currentState(roomId), type, key);
		if (current && current.sender === s.userId && JSON.stringify(current.content) === JSON.stringify(content)) return { event_id: current.event_id };
		const ts = s.appservice && ctx.query.get("ts") ? Number(ctx.query.get("ts")) : void 0;
		return { event_id: await ctx.hs.rooms.sendEvent(roomId, s.userId, {
			type,
			state_key: key,
			content
		}, { ts }) };
	};
	r.client("PUT", "/rooms/:roomId/state/:eventType", procedure({ handler: putState }));
	r.client("PUT", "/rooms/:roomId/state/:eventType/:stateKey", procedure({ handler: putState }));
	const getStateEvent = async (ctx) => {
		const s = await ctx.auth();
		const state = await visibleState(ctx.hs, ctx.params.roomId, s.userId);
		const ev = getState(state, ctx.params.eventType, ctx.params.stateKey ?? "");
		if (!ev) throw errors.notFound("State event not found");
		if (ctx.query.get("format") === "event") return ctx.hs.rooms.formatEvent({
			pdu: ev,
			stream: 0,
			snapshot: 0,
			txnId: null,
			txnToken: null
		});
		return ev.content;
	};
	r.client("GET", "/rooms/:roomId/state/:eventType", procedure({ handler: getStateEvent }));
	r.client("GET", "/rooms/:roomId/state/:eventType/:stateKey", procedure({ handler: getStateEvent }));
	r.client("GET", "/rooms/:roomId/state", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			return [...(await visibleState(ctx.hs, ctx.params.roomId, s.userId)).values()].map((ev) => toClientEvent(ev));
		}
	}));
	r.client("GET", "/rooms/:roomId/members", procedure({
		endpoint: "GET /v3/rooms/:roomId/members",
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const hs = ctx.hs;
			await hs.partialState.waitForFullState(ctx.params.roomId, ctx.request.signal);
			let state = await visibleState(hs, ctx.params.roomId, s.userId);
			const at = parseToken(ctx.query.get("at"));
			if (at !== null) {
				let row = (await hs.db.findMany("events", {
					where: [{
						field: "room_id",
						value: ctx.params.roomId
					}, {
						field: "stream",
						operator: "lte",
						value: at
					}],
					sortBy: {
						field: "stream",
						direction: "desc"
					},
					limit: 1
				}))[0];
				if (!row) {
					const first = await hs.db.findMany("events", {
						where: [{
							field: "room_id",
							value: ctx.params.roomId
						}],
						sortBy: {
							field: "stream",
							direction: "asc"
						},
						limit: 2
					});
					row = first[first.length - 1];
				}
				if (row) {
					if (!(await hs.rooms.filterVisible(s.userId, ctx.params.roomId, [hs.rooms.rowToStored(row)])).length) throw errors.forbidden("You may not view the room at this point");
					state = await hs.rooms.stateAtSnapshot(row.state_snapshot);
				}
			}
			const membership = ctx.query.get("membership");
			const notMembership = ctx.query.get("not_membership");
			const chunk = [];
			for (const [k, ev] of state) {
				if (splitStateKey(k)[0] !== M.ROOM.MEMBER) continue;
				const m = ev.content?.membership;
				if (membership && m !== membership) continue;
				if (notMembership && m === notMembership) continue;
				chunk.push(toClientEvent(ev));
			}
			return { chunk };
		}
	}));
	r.client("GET", "/rooms/:roomId/joined_members", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			await requireRoom(ctx.hs, ctx.params.roomId);
			await ctx.hs.partialState.waitForFullState(ctx.params.roomId, ctx.request.signal);
			const { joined: isJoined, worldReadable } = await ctx.hs.rooms.canPeek(ctx.params.roomId, s.userId);
			if (!isJoined && !worldReadable) throw errors.forbidden("You are not joined to this room");
			const state = await ctx.hs.rooms.currentState(ctx.params.roomId);
			const joined = {};
			for (const [k, ev] of state) {
				const [type, key] = splitStateKey(k);
				if (type !== M.ROOM.MEMBER || ev.content?.membership !== "join") continue;
				joined[key] = {
					display_name: ev.content.displayname ?? null,
					avatar_url: ev.content.avatar_url ?? null
				};
			}
			return { joined };
		}
	}));
	r.client("PUT", "/rooms/:roomId/redact/:eventId/:txnId", procedure({
		endpoint: "PUT /v3/rooms/:roomId/redact/:eventId/:txnId",
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const body = await ctx.json();
			const roomId = ctx.params.roomId;
			await requireRoom(ctx.hs, roomId);
			if (!await ownEvent(ctx.hs, s.userId, ctx.params.eventId)) await assertNotSuspended(ctx.hs, s, roomId);
			await ctx.hs.rooms.checkRedactionAllowed(roomId, s.userId, ctx.params.eventId);
			const content = typeof body.reason === "string" ? { reason: body.reason } : {};
			return { event_id: await ctx.hs.rooms.sendEvent(roomId, s.userId, {
				type: M.ROOM.REDACTION,
				content,
				redacts: ctx.params.eventId
			}, {
				txnId: ctx.params.txnId,
				deviceId: s.deviceId
			}) };
		}
	}));
	r.client("PUT", "/rooms/:roomId/typing/:userId", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			if (ctx.params.userId !== s.userId) throw errors.forbidden("Cannot set typing for another user");
			const body = await ctx.json();
			if (typeof body.typing !== "boolean") throw errors.badJson("typing must be a boolean");
			await ctx.hs.rooms.requireJoined(ctx.params.roomId, s.userId);
			await ctx.hs.typing.setTyping(ctx.params.roomId, s.userId, body.typing, Number(body.timeout) || 3e4);
			return {};
		}
	}));
	const RECEIPT_TYPES = [
		M.READ._,
		M.READ.PRIVATE,
		M.FULLY_READ
	];
	const setReceipt = async (hs, s, roomId, type, eventId, threadId) => {
		if (type === M.FULLY_READ) {
			await hs.streams.write((stream) => hs.db.upsert("account_data", {
				user_id: s.userId,
				room_id: roomId,
				type: M.FULLY_READ,
				content: { event_id: eventId },
				stream
			}));
			hs.notifier.notify([s.userId]);
			return;
		}
		const ev = await hs.rooms.getEvent(eventId);
		if (!ev || ev.pdu.room_id !== roomId) throw errors.notFound("Event not found");
		await hs.streams.write((stream) => hs.db.upsert("receipts", {
			room_id: roomId,
			user_id: s.userId,
			receipt_type: type,
			thread_id: threadId ?? "",
			event_id: eventId,
			ts: Date.now(),
			stream
		}));
		hs.notifier.notify(type === M.READ.PRIVATE ? [s.userId] : await hs.rooms.joinedMembers(roomId));
		await hs.federation.onReceipt(roomId, s.userId, type, eventId, Date.now(), threadId ?? "").catch((err) => hs.logger.warn("Receipt update to federation failed", err));
	};
	const receiptBody = body({ thread_id: v.string(fail("M_INVALID_PARAM", "Invalid thread_id")).min(1, "M_INVALID_PARAM: Invalid thread_id").optional() });
	r.client("POST", "/rooms/:roomId/receipt/:receiptType/:eventId", procedure({
		auth: "user",
		input: receiptBody,
		handler: async (ctx) => {
			const s = ctx.session;
			if (!RECEIPT_TYPES.includes(ctx.params.receiptType)) throw errors.invalidParam("Unknown receipt type");
			const body = ctx.input;
			await ctx.hs.rooms.requireJoined(ctx.params.roomId, s.userId);
			await setReceipt(ctx.hs, s, ctx.params.roomId, ctx.params.receiptType, ctx.params.eventId, body.thread_id);
			return {};
		}
	}));
	r.client("POST", "/rooms/:roomId/read_markers", procedure({
		auth: "user",
		input: body({}),
		handler: async (ctx) => {
			const s = ctx.session;
			const body = ctx.input;
			await ctx.hs.rooms.requireJoined(ctx.params.roomId, s.userId);
			for (const type of RECEIPT_TYPES) {
				const eventId = body[type];
				if (typeof eventId === "string") await setReceipt(ctx.hs, s, ctx.params.roomId, type, eventId);
			}
			return {};
		}
	}));
	const upgradeBody = body({
		new_version: v.string(fail("M_BAD_JSON", "Missing new_version")),
		additional_creators: v.unknown().optional()
	});
	r.client("POST", "/rooms/:roomId/upgrade", procedure({
		auth: "user",
		input: upgradeBody,
		handler: async (ctx) => {
			const s = ctx.session;
			const body = ctx.input;
			return { replacement_room: await upgradeRoom(ctx.hs, s, ctx.params.roomId, body.new_version, body.additional_creators) };
		}
	}));
	const reportBody = body({
		score: v.number(fail("M_INVALID_PARAM", "score must be between -100 and 0")).int("M_INVALID_PARAM: score must be between -100 and 0").min(-100, "M_INVALID_PARAM: score must be between -100 and 0").max(0, "M_INVALID_PARAM: score must be between -100 and 0").optional(),
		reason: v.string(fail("M_BAD_JSON", "reason must be a string")).optional()
	});
	const report = async (ctx) => {
		const s = ctx.session;
		const hs = ctx.hs;
		const roomId = ctx.params.roomId;
		await requireRoom(hs, roomId);
		if (ctx.params.eventId) {
			const ev = await hs.rooms.getEvent(ctx.params.eventId);
			if (!ev || ev.pdu.room_id !== roomId || !(await hs.rooms.filterVisible(s.userId, roomId, [ev])).length) throw errors.notFound("Event not found");
		} else if (await hs.rooms.membership(roomId, s.userId) !== "join") throw errors.notFound("Room not found");
		const body = ctx.input;
		const id = await hs.cluster.nextId("event_reports");
		await hs.db.create("event_reports", {
			id,
			ts: Date.now(),
			room_id: roomId,
			event_id: ctx.params.eventId ?? null,
			reporter: s.userId,
			reason: body.reason ?? null,
			score: body.score ?? null,
			resolved: false
		});
		await hs.audit.record({
			action: "event_report",
			actor: s.userId,
			target: ctx.params.eventId ?? roomId,
			details: {
				room_id: roomId,
				report_id: id
			}
		});
		if (hs.adminRoom) hs.adminRoom.say(`New report #${id} from ${s.userId} about ${ctx.params.eventId ?? "room"} in ${roomId}: ${body.reason ?? "(no reason)"}`).catch((err) => hs.logger.warn("Posting the report to the admin room failed", err));
		return {};
	};
	r.client("POST", "/users/:userId/report", procedure({
		auth: "user",
		input: body({ reason: v.string(fail("M_BAD_JSON", "reason must be a string")) }),
		handler: async (ctx) => {
			const s = ctx.session;
			const hs = ctx.hs;
			const body = ctx.input;
			const userId = ctx.params.userId;
			if (!isValidUserId(userId)) throw errors.invalidParam("Invalid user ID");
			if (hs.isLocalUser(userId) && !await hs.db.findOne("users", [{
				field: "user_id",
				value: userId
			}])) throw errors.notFound("Unknown user");
			const id = await hs.cluster.nextId("user_reports");
			await hs.db.create("user_reports", {
				id,
				ts: Date.now(),
				user_id: userId,
				reporter: s.userId,
				reason: body.reason,
				resolved: false
			});
			await hs.audit.record({
				action: "user_report",
				actor: s.userId,
				target: userId,
				details: { report_id: id }
			});
			if (hs.adminRoom) hs.adminRoom.say(`New user report #${id} from ${s.userId} about ${userId}: ${body.reason || "(no reason)"}`).catch((err) => hs.logger.warn("Posting the report to the admin room failed", err));
			return {};
		}
	}));
	r.client("GET", "/mutual_rooms", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const other = ctx.query.get("user_id");
			if (other === null) throw errors.missingParam("Missing user_id");
			if (!isValidUserId(other)) throw errors.invalidParam("Invalid user_id");
			if (other === s.userId) throw errors.invalidParam("user_id must not be your own");
			const theirs = new Set(await ctx.hs.rooms.roomsForUser(other));
			const joined = (await ctx.hs.rooms.roomsForUser(s.userId)).filter((r) => theirs.has(r)).sort();
			const from = ctx.query.get("from");
			const start = from === null ? 0 : joined.findIndex((r) => r > from);
			if (from !== null && !isValidRoomId(from)) throw errors.invalidParam("Invalid from token");
			const page = start < 0 ? [] : joined.slice(start, start + 100);
			const out = {
				joined: page,
				count: joined.length
			};
			if (start >= 0 && start + 100 < joined.length) out.next_batch = page[page.length - 1];
			return out;
		}
	}), ["v1"]);
	r.client("POST", "/rooms/:roomId/report/:eventId", procedure({
		auth: "user",
		input: reportBody,
		handler: report
	}));
	r.client("POST", "/rooms/:roomId/report", procedure({
		auth: "user",
		input: reportBody,
		handler: report
	}));
	r.client("GET", "/admin/whois/:userId", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const userId = ctx.params.userId;
			if (userId !== s.userId && !s.isAdmin) throw errors.forbidden("Only server admins can look up other users");
			if (!ctx.hs.isLocalUser(userId)) throw errors.notFound("Unknown user");
			const devices = await ctx.hs.db.findMany("devices", { where: [{
				field: "user_id",
				value: userId
			}] });
			const out = {};
			for (const d of devices) out[d.device_id] = { sessions: [{ connections: d.last_seen_ip ? [{
				ip: d.last_seen_ip,
				last_seen: d.last_seen_ts
			}] : [] }] };
			return {
				user_id: userId,
				devices: out
			};
		}
	}));
}
export { ownEvent, parseToken, registerRoomRoutes, requireRoom, viewerOf, visibleState };

//# sourceMappingURL=rooms.js.map