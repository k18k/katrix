import { canonicalJson } from "../shared/canonical-json.js";
import { isObject } from "../shared/json.js";
import { M } from "../shared/m.js";
import { randomString, sha256, signJson, unpaddedBase64, urlSafeBase64 } from "./crypto.js";
// src/core/events.ts
const STABLE_ROOM_VERSIONS = [
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"10",
	"11",
	"12"
];
/** Experimental versions: an MSC's changes on top of a stable version. */
const UNSTABLE_ROOM_VERSIONS = [
	"org.matrix.msc3757.10",
	"org.matrix.msc3757.11",
	"org.matrix.msc3389.10"
];
const SUPPORTED_ROOM_VERSIONS = [...STABLE_ROOM_VERSIONS, ...UNSTABLE_ROOM_VERSIONS];
/** The stable version an (experimental) room version is based on, e.g. "org.matrix.msc3757.10" → 10. */
const versionNum = (v) => {
	let start = v.length;
	while (start > 0 && v.charCodeAt(start - 1) >= 48 && v.charCodeAt(start - 1) <= 57) start--;
	return Number.parseInt(start < v.length ? v.slice(start) : v, 10);
};
const roomVersionFeatures = (version) => {
	const n = versionNum(version);
	return {
		/** v1/v2 use server-generated event IDs and `[id, hashes]` tuples in prev/auth events. */
		legacyEventIds: n <= 2,
		urlSafeEventIds: n >= 4,
		knock: n >= 7,
		restricted: n >= 8,
		knockRestricted: n >= 10,
		integerPowerLevels: n >= 10,
		/** v11: creator is the sender of the create event; `redacts` moves into content. */
		v11: n >= 11,
		/**
		* v12: room ID is the create event's reference hash, the create event has no room_id and is
		* omitted from auth_events, and room creators have unlimited power.
		*/
		v12: n >= 12,
		/** MSC3757: state keys "@user:server[_suffix]" are owned by that user. */
		ownedState: version.startsWith("org.matrix.msc3757."),
		/** MSC3389: redactions keep m.relates_to. */
		redactionKeepsRelations: version.startsWith("org.matrix.msc3389.")
	};
};
const KEEP_TOP_LEVEL = [
	"event_id",
	"type",
	"room_id",
	"sender",
	"state_key",
	"content",
	"hashes",
	"signatures",
	"depth",
	"prev_events",
	"auth_events",
	"origin_server_ts"
];
const KEEP_TOP_LEVEL_LEGACY = [
	"prev_state",
	"origin",
	"membership"
];
/** Apply the redaction algorithm for the given room version. */
function redact(event, roomVersion) {
	const n = versionNum(roomVersion);
	const keep = n >= 11 ? KEEP_TOP_LEVEL : [...KEEP_TOP_LEVEL, ...KEEP_TOP_LEVEL_LEGACY];
	const out = {};
	for (const k of keep) if (k in event) out[k] = event[k];
	const keepRelation = roomVersion.startsWith("org.matrix.msc3389.") && isObject(event.content?.[M.RELATES_TO]) ? event.content[M.RELATES_TO] : void 0;
	const content = isObject(event.content) ? event.content : {};
	const pick = (...keys) => {
		const c = {};
		for (const k of keys) if (k in content) c[k] = content[k];
		return c;
	};
	switch (event.type) {
		case M.ROOM.MEMBER: {
			const c = pick("membership", ...n >= 9 ? ["join_authorised_via_users_server"] : []);
			if (n >= 11 && isObject(content.third_party_invite) && "signed" in content.third_party_invite) c.third_party_invite = { signed: content.third_party_invite.signed };
			out.content = c;
			break;
		}
		case M.ROOM.CREATE:
			out.content = n >= 11 ? { ...content } : pick("creator");
			break;
		case M.ROOM.JOIN_RULES:
			out.content = pick("join_rule", ...n >= 8 ? ["allow"] : []);
			break;
		case M.ROOM.POWER_LEVELS:
			out.content = pick("ban", "events", "events_default", "kick", "redact", "state_default", "users", "users_default", ...n >= 11 ? ["invite"] : []);
			break;
		case M.ROOM.HISTORY_VISIBILITY:
			out.content = pick("history_visibility");
			break;
		case M.ROOM.ALIASES:
			out.content = n <= 5 ? pick("aliases") : {};
			break;
		case M.ROOM.REDACTION:
			out.content = n >= 11 ? pick("redacts") : {};
			break;
		default: out.content = {};
	}
	if (keepRelation) {
		const rel = {};
		if ("rel_type" in keepRelation) rel.rel_type = keepRelation.rel_type;
		if ("event_id" in keepRelation) rel.event_id = keepRelation.event_id;
		out.content = {
			...out.content,
			[M.RELATES_TO]: rel
		};
	}
	return out;
}
function computeContentHash(pdu) {
	const { unsigned, signatures, hashes, ...rest } = pdu;
	return unpaddedBase64(sha256(canonicalJson(rest)));
}
function computeReferenceHash(pdu, roomVersion) {
	const { signatures, unsigned, event_id, ...rest } = redact(pdu, roomVersion);
	return sha256(canonicalJson(rest));
}
/** Finalise a PDU: compute hashes, signatures and the event ID. */
function finalisePdu(pdu, roomVersion, serverName, key) {
	const features = roomVersionFeatures(roomVersion);
	if (features.legacyEventIds) {
		pdu.event_id = `$${randomString(18)}:${serverName}`;
		pdu.origin = serverName;
	}
	pdu.hashes = { sha256: computeContentHash(pdu) };
	const redacted = redact(pdu, roomVersion);
	signJson(redacted, serverName, key);
	pdu.signatures = redacted.signatures;
	if (!features.legacyEventIds) {
		const hash = computeReferenceHash(pdu, roomVersion);
		pdu.event_id = `$${features.urlSafeEventIds ? urlSafeBase64(hash) : unpaddedBase64(hash)}`;
	}
	return pdu;
}
function eventIdOf(ref) {
	return Array.isArray(ref) ? ref[0] : ref;
}
/** Convert a stored PDU into the client-server event format. */
function toClientEvent(pdu, opts = {}) {
	const ev = {
		event_id: pdu.event_id,
		sender: pdu.sender,
		type: pdu.type,
		content: pdu.content,
		origin_server_ts: pdu.origin_server_ts
	};
	if (opts.includeRoomId !== false) ev.room_id = pdu.room_id;
	if (pdu.state_key !== void 0) ev.state_key = pdu.state_key;
	if (pdu.redacts !== void 0) ev.redacts = pdu.redacts;
	else if (pdu.type === M.ROOM.REDACTION && typeof pdu.content?.redacts === "string") ev.redacts = pdu.content.redacts;
	ev.unsigned = {
		...pdu.unsigned,
		age: Math.max(0, Date.now() - pdu.origin_server_ts)
	};
	return ev;
}
function stripState(pdu) {
	return {
		type: pdu.type,
		state_key: pdu.state_key,
		sender: pdu.sender,
		content: pdu.content
	};
}
const stateKey = (type, key) => `${type}\u0000${key}`;
const splitStateKey = (k) => {
	const i = k.indexOf("\0");
	return [k.slice(0, i), k.slice(i + 1)];
};
export { STABLE_ROOM_VERSIONS, SUPPORTED_ROOM_VERSIONS, UNSTABLE_ROOM_VERSIONS, computeContentHash, computeReferenceHash, eventIdOf, finalisePdu, redact, roomVersionFeatures, splitStateKey, stateKey, stripState, toClientEvent, versionNum };

//# sourceMappingURL=events.js.map