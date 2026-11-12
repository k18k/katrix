import { isObject } from "../shared/json.js";
import { M, UNSTABLE } from "../shared/m.js";
import { globMatch as globMatch$1 } from "../shared/glob.js";
import { errors } from "../core/errors.js";
// src/api/filters.ts
function globMatch(pattern, value) {
	return globMatch$1(pattern, value, { questionMark: false });
}
function matchesFilter(filter, ev) {
	if (!filter) return true;
	if (filter.not_types?.some((t) => globMatch(t, ev.type))) return false;
	if (filter.types && !filter.types.some((t) => globMatch(t, ev.type))) return false;
	if (ev.sender !== void 0) {
		if (filter.not_senders?.includes(ev.sender)) return false;
		if (filter.senders && !filter.senders.includes(ev.sender)) return false;
	}
	if (ev.room_id !== void 0) {
		if (filter.not_rooms?.includes(ev.room_id)) return false;
		if (filter.rooms && !filter.rooms.includes(ev.room_id)) return false;
	}
	const relTypes = filter.rel_types ?? filter[UNSTABLE.ORG.MATRIX.MSC3874.REL_TYPES];
	const notRelTypes = filter.not_rel_types ?? filter[UNSTABLE.ORG.MATRIX.MSC3874.NOT_REL_TYPES];
	if (relTypes || notRelTypes) {
		const relType = ev.content?.[M.RELATES_TO]?.rel_type;
		if (relTypes && !relTypes.includes(relType)) return false;
		if (notRelTypes && typeof relType === "string" && notRelTypes.includes(relType)) return false;
	}
	if (filter.contains_url !== void 0) {
		if (typeof ev.content?.url === "string" !== filter.contains_url) return false;
	}
	return true;
}
function roomAllowed(filter, roomId) {
	const r = filter.room;
	if (!r) return true;
	if (r.not_rooms?.includes(roomId)) return false;
	if (r.rooms && !r.rooms.includes(roomId)) return false;
	return true;
}
function validateEventFilter(f, name) {
	if (f === void 0) return;
	if (!isObject(f)) throw errors.badJson(`${name} must be an object`);
	for (const key of [
		"types",
		"not_types",
		"senders",
		"not_senders",
		"rooms",
		"not_rooms"
	]) if (f[key] !== void 0 && (!Array.isArray(f[key]) || !f[key].every((x) => typeof x === "string"))) throw errors.badJson(`${name}.${key} must be a list of strings`);
	if (f.rooms?.some((r) => !r.startsWith("!")) || f.not_rooms?.some((r) => !r.startsWith("!"))) throw errors.badJson(`${name}: rooms must be room IDs`);
	if (f.senders?.some((u) => !u.startsWith("@")) || f.not_senders?.some((u) => !u.startsWith("@"))) throw errors.badJson(`${name}: senders must be user IDs`);
	if (f.limit !== void 0 && (!Number.isInteger(f.limit) || f.limit < 0)) throw errors.badJson(`${name}.limit must be a non-negative integer`);
}
function validateSyncFilter(f) {
	if (!isObject(f)) throw errors.badJson("Filter must be an object");
	for (const k of ["presence", "account_data"]) validateEventFilter(f[k], k);
	if (f.room !== void 0) {
		if (!isObject(f.room)) throw errors.badJson("room must be an object");
		for (const k of [
			"timeline",
			"state",
			"ephemeral",
			"account_data"
		]) validateEventFilter(f.room[k], `room.${k}`);
		validateEventFilter({
			rooms: f.room.rooms,
			not_rooms: f.room.not_rooms
		}, "room");
	}
	if (f.event_format !== void 0 && !["client", "federation"].includes(f.event_format)) throw errors.badJson("Invalid event_format");
	return f;
}
/** Parse the `filter` query param of /messages and /context (a JSON RoomEventFilter). */
function parseRoomEventFilter(ctx) {
	const raw = ctx.query.get("filter");
	if (!raw) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw errors.badJson("Invalid filter JSON");
	}
	validateEventFilter(parsed, "filter");
	return parsed;
}
export { matchesFilter, parseRoomEventFilter, roomAllowed, validateSyncFilter };

//# sourceMappingURL=filters.js.map