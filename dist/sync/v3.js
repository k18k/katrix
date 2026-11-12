import { isObject } from "../shared/json.js";
// src/sync/v3.ts
const arr = (v) => Array.isArray(v) ? v : [];
const obj = (v) => isObject(v) ? v : {};
const numberOrUndefined = (v) => typeof v === "number" ? v : void 0;
const counts = (v) => ({
	highlight_count: numberOrUndefined(v.highlight_count),
	notification_count: numberOrUndefined(v.notification_count)
});
const events = (v) => arr(obj(v).events).filter((e) => typeof e === "object" && e !== null && typeof e.type === "string");
function timeline(v) {
	const t = obj(v);
	return {
		events: events(t),
		limited: t.limited === true,
		prevBatch: typeof t.prev_batch === "string" ? t.prev_batch : void 0
	};
}
/** GET /_matrix/client/v3/sync (https://spec.matrix.org/v1.16/client-server-api/#get_matrixclientv3sync). */
var SyncV3Transport = class {
	kind = "v3";
	api;
	filter;
	useStateAfter;
	constructor(api, opts = {}) {
		this.api = api;
		this.useStateAfter = opts.useStateAfter ?? true;
		if (typeof opts.filter === "string") this.filter = opts.filter;
		else {
			const lazy = opts.lazyLoadMembers ?? true;
			this.filter = JSON.stringify(opts.filter ?? { room: {
				state: { lazy_load_members: lazy },
				timeline: {
					limit: opts.timelineLimit ?? 20,
					lazy_load_members: lazy,
					unread_thread_notifications: true
				}
			} });
		}
	}
	async sync(req) {
		return parseV3(await this.api.endpoint("GET /v3/sync", {}, {
			query: {
				since: req.since,
				timeout: req.timeoutMs,
				filter: this.filter,
				set_presence: req.setPresence,
				use_state_after: this.useStateAfter ? true : void 0
			},
			signal: req.signal,
			timeoutMs: req.timeoutMs + 3e4
		}), req.since === void 0);
	}
};
/**
* The response is typed as the spec's SyncResponse (@katrix/shared) but read as untrusted data:
* every field is checked, and anything malformed is skipped rather than trusted.
*/
function parseV3(response, initial) {
	const res = { ...response };
	if (typeof res.next_batch !== "string") throw new Error("Sync response has no next_batch");
	const rooms = obj(res.rooms);
	const join = {};
	for (const [roomId, r] of Object.entries(obj(rooms.join))) {
		const room = obj(r);
		const summary = obj(room.summary);
		const after = room.state_after !== void 0;
		join[roomId] = {
			state: events(after ? room.state_after : room.state),
			stateAfter: after,
			initial,
			timeline: timeline(room.timeline),
			ephemeral: events(room.ephemeral),
			accountData: events(room.account_data),
			summary: room.summary ? {
				heroes: arr(summary["m.heroes"]),
				joinedMemberCount: numberOrUndefined(summary["m.joined_member_count"]),
				invitedMemberCount: numberOrUndefined(summary["m.invited_member_count"])
			} : void 0,
			unreadNotifications: isObject(room.unread_notifications) ? counts(room.unread_notifications) : void 0,
			unreadThreadNotifications: isObject(room.unread_thread_notifications) ? Object.fromEntries(Object.entries(room.unread_thread_notifications).map(([thread, c]) => [thread, counts(obj(c))])) : void 0
		};
	}
	const invited = (section) => {
		const out = {};
		for (const [roomId, r] of Object.entries(obj(section))) out[roomId] = { strippedState: arr(obj(obj(r).invite_state).events) };
		return out;
	};
	const leave = {};
	for (const [roomId, r] of Object.entries(obj(rooms.leave))) {
		const room = obj(r);
		const after = room.state_after !== void 0;
		leave[roomId] = {
			state: events(after ? room.state_after : room.state),
			stateAfter: after,
			timeline: timeline(room.timeline),
			accountData: events(room.account_data)
		};
	}
	const knock = {};
	for (const [roomId, r] of Object.entries(obj(rooms.knock))) knock[roomId] = { strippedState: arr(obj(obj(r).knock_state).events) };
	const deviceLists = obj(res.device_lists);
	return {
		nextBatch: res.next_batch,
		rooms: {
			join,
			invite: invited(rooms.invite),
			leave,
			knock
		},
		toDevice: arr(obj(res.to_device).events),
		deviceLists: {
			changed: arr(deviceLists.changed),
			left: arr(deviceLists.left)
		},
		oneTimeKeyCounts: isObject(res.device_one_time_keys_count) ? Object.fromEntries(Object.entries(res.device_one_time_keys_count).filter((e) => typeof e[1] === "number")) : void 0,
		unusedFallbackKeyTypes: Array.isArray(res.device_unused_fallback_key_types) ? res.device_unused_fallback_key_types : void 0,
		accountData: events(res.account_data),
		presence: events(res.presence)
	};
}
export { SyncV3Transport, parseV3 };

//# sourceMappingURL=v3.js.map