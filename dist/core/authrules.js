import { isValidUserId } from "../shared/ids.js";
import { isObject } from "../shared/json.js";
import { M } from "../shared/m.js";
import { publicKeyFromBase64, verifyJsonSignature } from "./crypto.js";
import { roomVersionFeatures, stateKey, versionNum } from "./events.js";
import { errors } from "./errors.js";
// src/core/authrules.ts
/** MSC3757: the user owning a state key of the form "@user:server" or "@user:server_suffix". */
function ownerOfStateKey(stateKeyValue) {
	const key = stateKeyValue;
	if (!key.startsWith("@")) return null;
	if (isValidUserId(stateKeyValue)) return stateKeyValue;
	const colon = key.indexOf(":");
	if (colon < 0) return null;
	const underscore = key.indexOf("_", colon);
	if (underscore < 0) return null;
	const owner = key.slice(0, underscore);
	return isValidUserId(owner) ? owner : null;
}
function getState(state, type, key = "") {
	return state.get(stateKey(type, key));
}
function membershipOf(state, userId) {
	return getState(state, M.ROOM.MEMBER, userId)?.content?.membership ?? "leave";
}
function roomCreator(state, roomVersion) {
	const create = getState(state, M.ROOM.CREATE);
	if (!create) return void 0;
	return roomVersionFeatures(roomVersion).v11 ? create.sender : create.content.creator ?? create.sender;
}
const toInt = (v, fallback) => {
	if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
	if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10);
	return fallback;
};
/** v12+: the create event's sender plus `additional_creators`. Empty for older versions. */
function roomCreators(state, roomVersion) {
	if (!roomVersionFeatures(roomVersion).v12) return /* @__PURE__ */ new Set();
	const create = getState(state, M.ROOM.CREATE);
	if (!create) return /* @__PURE__ */ new Set();
	const extra = Array.isArray(create.content?.additional_creators) ? create.content.additional_creators : [];
	return /* @__PURE__ */ new Set([create.sender, ...extra.filter((u) => typeof u === "string")]);
}
function powerLevels(state, roomVersion) {
	const pl = getState(state, M.ROOM.POWER_LEVELS)?.content;
	const creators = roomCreators(state, roomVersion);
	if (!pl) {
		const creator = roomCreator(state, roomVersion);
		return {
			creators,
			users: creator ? { [creator]: 100 } : {},
			users_default: 0,
			events: {},
			events_default: 0,
			state_default: 0,
			ban: 50,
			kick: 50,
			redact: 50,
			invite: 0,
			notifications: { room: 50 }
		};
	}
	const users = {};
	if (isObject(pl.users)) for (const [u, v] of Object.entries(pl.users)) users[u] = toInt(v, 0);
	const events = {};
	if (isObject(pl.events)) for (const [e, v] of Object.entries(pl.events)) events[e] = toInt(v, 0);
	const notifications = { room: 50 };
	if (isObject(pl.notifications)) for (const [e, v] of Object.entries(pl.notifications)) notifications[e] = toInt(v, 50);
	return {
		creators,
		users,
		events,
		notifications,
		users_default: toInt(pl.users_default, 0),
		events_default: toInt(pl.events_default, 0),
		state_default: toInt(pl.state_default, 50),
		ban: toInt(pl.ban, 50),
		kick: toInt(pl.kick, 50),
		redact: toInt(pl.redact, 50),
		invite: toInt(pl.invite, 0)
	};
}
function userLevel(pl, userId) {
	if (pl.creators.has(userId)) return Infinity;
	return pl.users[userId] ?? pl.users_default;
}
function requiredLevel(pl, type, isState) {
	return pl.events[type] ?? (isState ? pl.state_default : pl.events_default);
}
const sameDomain = (a, b) => a.slice(a.indexOf(":") + 1) === b.slice(b.indexOf(":") + 1);
const domainOf = (id) => id.slice(id.indexOf(":") + 1);
/** The (type, state_key) pairs an event's auth_events may reference (spec "auth events selection"). */
function authEventKeys(event, roomVersion) {
	if (event.type === M.ROOM.CREATE) return [];
	const keys = [stateKey(M.ROOM.POWER_LEVELS, ""), stateKey(M.ROOM.MEMBER, event.sender)];
	if (!roomVersionFeatures(roomVersion).v12) keys.unshift(stateKey(M.ROOM.CREATE, ""));
	if (event.type === M.ROOM.MEMBER && typeof event.state_key === "string") {
		keys.push(stateKey(M.ROOM.MEMBER, event.state_key));
		const membership = event.content?.membership;
		if ([
			"join",
			"invite",
			"knock"
		].includes(membership)) keys.push(stateKey(M.ROOM.JOIN_RULES, ""));
		const token = event.content?.third_party_invite?.signed?.token;
		if (membership === "invite" && typeof token === "string") keys.push(stateKey(M.ROOM.THIRD_PARTY_INVITE, token));
		const via = event.content?.join_authorised_via_users_server;
		if (membership === "join" && typeof via === "string" && roomVersionFeatures(roomVersion).restricted) keys.push(stateKey(M.ROOM.MEMBER, via));
	}
	return [...new Set(keys)];
}
/**
* Build the auth state for an event from its auth_events, validating rule 2 of the
* authorization rules (no duplicates, only expected types). For v12 the create event
* (identified by the room ID) must be supplied separately.
*/
function authStateFromAuthEvents(event, authEvents, roomVersion, createEvent) {
	const allowed = new Set(authEventKeys(event, roomVersion));
	const state = /* @__PURE__ */ new Map();
	for (const ev of authEvents) {
		if (ev.state_key === void 0) throw errors.forbidden("Auth event is not a state event");
		const key = stateKey(ev.type, ev.state_key);
		if (state.has(key)) throw errors.forbidden("Duplicate auth event");
		if (!allowed.has(key)) throw errors.forbidden(`Unexpected auth event ${ev.type}`);
		if (roomVersionFeatures(roomVersion).v12 && ev.type === M.ROOM.CREATE) throw errors.forbidden("Create event must not be in auth_events");
		state.set(key, ev);
	}
	if (createEvent) state.set(stateKey(M.ROOM.CREATE, ""), createEvent);
	return state;
}
/**
* The Matrix authorization rules: throws M_FORBIDDEN if `event` is not allowed
* given `state` (either its auth events or the state before it).
*/
function checkAuth(event, state, roomVersion, opts = {}) {
	const features = roomVersionFeatures(roomVersion);
	const n = versionNum(roomVersion);
	const deny = (msg) => {
		throw errors.forbidden(msg);
	};
	if (event.type === M.ROOM.CREATE) {
		if (state.size > 0 || Array.isArray(event.prev_events) && event.prev_events.length > 0) deny("Create event must be the first event");
		if (!features.v12 && event.room_id && !sameDomain(event.room_id, event.sender)) deny("Room ID domain must match the creator");
		const rv = event.content?.room_version;
		if (rv !== void 0 && (typeof rv !== "string" || !Number.isFinite(versionNum(rv)))) deny("Unknown room version");
		if (!features.v11 && typeof event.content?.creator !== "string") deny("Create event lacks a creator");
		if (features.v12) {
			const extra = event.content?.additional_creators;
			if (extra !== void 0 && (!Array.isArray(extra) || !extra.every(isValidUserId))) deny("Invalid additional_creators");
		}
		return;
	}
	const create = getState(state, M.ROOM.CREATE);
	if (!create) deny("No create event in room");
	if (create.content?.[M.FEDERATE] === false && !sameDomain(event.sender, create.sender)) deny("Room is not federated");
	if (n <= 5 && event.type === M.ROOM.ALIASES) {
		if (event.state_key === void 0) deny("Aliases event lacks a state key");
		if (event.state_key !== domainOf(event.sender)) deny("Aliases state key must be the sender's domain");
		return;
	}
	const pl = powerLevels(state, roomVersion);
	const senderMembership = membershipOf(state, event.sender);
	const senderLevel = userLevel(pl, event.sender);
	if (event.type === M.ROOM.MEMBER) {
		const target = event.state_key;
		const membership = event.content?.membership;
		if (typeof target !== "string" || typeof membership !== "string") deny("Member event lacks state_key or membership");
		const targetMembership = membershipOf(state, target);
		const joinRule = getState(state, M.ROOM.JOIN_RULES)?.content?.join_rule ?? "invite";
		const via = event.content?.join_authorised_via_users_server;
		switch (membership) {
			case "join": {
				const prev = Array.isArray(event.prev_events) ? event.prev_events.map((p) => Array.isArray(p) ? p[0] : p) : [];
				const creator = roomCreator(state, roomVersion);
				if (prev.length === 1 && prev[0] === create.event_id && target === creator && event.sender === target) return;
				if (state.size === 1 && creator === target && event.sender === target) return;
				if (event.sender !== target) deny("Cannot force another user to join");
				if (targetMembership === "ban") deny("User is banned from the room");
				if (joinRule === "invite" || features.knock && joinRule === "knock") {
					if (targetMembership === "join" || targetMembership === "invite") return;
					deny("You are not invited to this room");
				}
				if (features.restricted && joinRule === "restricted" || features.knockRestricted && joinRule === "knock_restricted") {
					if (targetMembership === "join" || targetMembership === "invite") return;
					if (typeof via === "string" && opts.joinAuthorisedSignatureValid === false) deny("join_authorised_via_users_server is not signed by that server");
					if (typeof via === "string" && membershipOf(state, via) === "join" && userLevel(pl, via) >= pl.invite) return;
					deny("Join not authorised by restricted join rules");
				}
				if (joinRule === "public") return;
				deny("You are not allowed to join this room");
				break;
			}
			case "invite":
				if (event.content?.third_party_invite !== void 0) {
					if (targetMembership === "ban") deny("User is banned");
					if (!checkThirdPartyInvite(event, state)) deny("Invalid third party invite");
					return;
				}
				if (senderMembership !== "join") deny("Sender not in room");
				if (targetMembership === "join" || targetMembership === "ban") deny(`User is already ${targetMembership === "join" ? "joined" : "banned"}`);
				if (senderLevel >= pl.invite) return;
				deny("Insufficient power level to invite");
				break;
			case "leave":
				if (event.sender === target) {
					if (targetMembership === "join" || targetMembership === "invite" || features.knock && targetMembership === "knock") return;
					deny("User is not in the room");
				}
				if (senderMembership !== "join") deny("Sender not in room");
				if (targetMembership === "ban" && senderLevel < pl.ban) deny("Insufficient power level to unban");
				if (senderLevel >= pl.kick && userLevel(pl, target) < senderLevel) return;
				deny("Insufficient power level to kick");
				break;
			case "ban":
				if (senderMembership !== "join") deny("Sender not in room");
				if (senderLevel >= pl.ban && userLevel(pl, target) < senderLevel) return;
				deny("Insufficient power level to ban");
				break;
			case "knock":
				if (!features.knock) deny("Knocking is not supported in this room version");
				if (joinRule !== "knock" && !(features.knockRestricted && joinRule === "knock_restricted")) deny("Room does not allow knocking");
				if (event.sender !== target) deny("Cannot knock on behalf of another user");
				if (targetMembership === "ban" || targetMembership === "join" || targetMembership === "invite") deny(`Cannot knock while ${targetMembership}`);
				return;
			default: deny("Unknown membership");
		}
		return;
	}
	if (senderMembership !== "join") deny("You are not joined to this room");
	if (event.type === M.ROOM.THIRD_PARTY_INVITE) {
		if (senderLevel >= pl.invite) return;
		deny("Insufficient power level to invite");
	}
	const isState = event.state_key !== void 0;
	if (senderLevel < requiredLevel(pl, event.type, isState)) deny("Insufficient power level to send this event");
	if (isState && event.state_key.startsWith("@") && event.state_key !== event.sender) {
		if (!features.ownedState) deny("State keys starting with @ are reserved for that user");
		const owner = ownerOfStateKey(event.state_key);
		if (!owner) deny("Malformed user-owned state key");
		if (owner !== event.sender && senderLevel <= userLevel(pl, owner)) deny("This state key belongs to another user");
	}
	if (event.type === M.ROOM.POWER_LEVELS && isState) {
		if (isObject(event.content?.users)) for (const u of Object.keys(event.content.users)) {
			if (!isValidUserId(u)) deny("Power level users must be valid user IDs");
			if (pl.creators.has(u)) deny("Room creators cannot be given a power level");
		}
		if (getState(state, M.ROOM.POWER_LEVELS)) checkPowerLevelChange(event, pl, senderLevel, features.integerPowerLevels, n >= 6, deny);
		else checkPowerLevelShape(event, features.integerPowerLevels, deny);
		return;
	}
	if (n <= 2 && event.type === M.ROOM.REDACTION) {
		if (senderLevel >= pl.redact) return;
		const redacts = event.redacts;
		if (typeof redacts === "string" && redacts.includes(":") && domainOf(redacts) === domainOf(event.sender)) return;
		deny("Insufficient power level to redact");
	}
}
function checkThirdPartyInvite(event, state) {
	const signed = event.content?.third_party_invite?.signed;
	if (!isObject(signed) || typeof signed.mxid !== "string" || typeof signed.token !== "string") return false;
	if (signed.mxid !== event.state_key) return false;
	const invite = getState(state, M.ROOM.THIRD_PARTY_INVITE, signed.token);
	if (!invite || invite.sender !== event.sender) return false;
	const keys = [];
	if (typeof invite.content?.public_key === "string") keys.push(invite.content.public_key);
	for (const k of Array.isArray(invite.content?.public_keys) ? invite.content.public_keys : []) if (typeof k?.public_key === "string") keys.push(k.public_key);
	for (const key of keys) {
		let pub;
		try {
			pub = publicKeyFromBase64(key);
		} catch {
			continue;
		}
		for (const [server, sigs] of Object.entries(isObject(signed.signatures) ? signed.signatures : {})) for (const keyId of Object.keys(isObject(sigs) ? sigs : {})) if (verifyJsonSignature(signed, server, keyId, pub)) return true;
	}
	return false;
}
function checkPowerLevelShape(event, integerOnly, deny) {
	if (!integerOnly) return;
	const c = event.content ?? {};
	const isInt = (v) => typeof v === "number" && Number.isInteger(v);
	for (const key of [
		"users_default",
		"events_default",
		"state_default",
		"ban",
		"redact",
		"kick",
		"invite"
	]) if (key in c && !isInt(c[key])) deny(`${key} must be an integer`);
	for (const map of [
		"users",
		"events",
		"notifications"
	]) {
		if (map in c && !isObject(c[map])) deny(`${map} must be an object`);
		if (isObject(c[map])) {
			for (const v of Object.values(c[map])) if (!isInt(v)) deny(`${map} values must be integers`);
		}
	}
}
function checkPowerLevelChange(event, current, senderLevel, integerOnly, checkNotifications, deny) {
	const c = event.content ?? {};
	checkPowerLevelShape(event, integerOnly, deny);
	if (!integerOnly) {
		for (const map of [
			"users",
			"events",
			"notifications"
		]) if (map in c && !isObject(c[map])) deny(`${map} must be an object`);
	}
	const next = {
		users_default: toInt(c.users_default, 0),
		events_default: toInt(c.events_default, 0),
		state_default: toInt(c.state_default, 50),
		ban: toInt(c.ban, 50),
		redact: toInt(c.redact, 50),
		kick: toInt(c.kick, 50),
		invite: toInt(c.invite, 0)
	};
	for (const key of Object.keys(next)) {
		const old = current[key];
		if (old !== next[key] && (old > senderLevel || next[key] > senderLevel)) deny(`Cannot change ${key} beyond your own level`);
	}
	const compareMap = (oldMap, newMap, isUsers) => {
		const keys = /* @__PURE__ */ new Set([...Object.keys(oldMap), ...Object.keys(newMap ?? {})]);
		for (const k of keys) {
			const o = oldMap[k];
			const nv = newMap?.[k] === void 0 ? void 0 : toInt(newMap[k], 0);
			if (o === nv) continue;
			if (isUsers) {
				if (k !== event.sender && o !== void 0 && o >= senderLevel) deny("Cannot change the level of a user with equal or higher power");
				if (nv !== void 0 && nv > senderLevel) deny("Cannot set a level above your own");
			} else {
				if (o !== void 0 && o > senderLevel) deny("Cannot change a level above your own");
				if (nv !== void 0 && nv > senderLevel) deny("Cannot set a level above your own");
			}
		}
	};
	compareMap(current.users, c.users ?? {}, true);
	compareMap(current.events, c.events ?? {}, false);
	if (checkNotifications) compareMap({ ...current.notifications }, {
		room: 50,
		...c.notifications
	}, false);
}
export { authEventKeys, authStateFromAuthEvents, checkAuth, getState, membershipOf, ownerOfStateKey, powerLevels, requiredLevel, roomCreator, roomCreators, userLevel };

//# sourceMappingURL=authrules.js.map