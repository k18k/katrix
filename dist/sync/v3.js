const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
const events = (v) => arr(obj(v).events).filter((e) => typeof e === "object" && e !== null && typeof e.type === "string");
function timeline(v) {
    const t = obj(v);
    return { events: events(t), limited: t.limited === true, prevBatch: typeof t.prev_batch === "string" ? t.prev_batch : undefined };
}
/** GET /_matrix/client/v3/sync (https://spec.matrix.org/v1.16/client-server-api/#get_matrixclientv3sync). */
export class SyncV3Transport {
    kind = "v3";
    api;
    filter;
    constructor(api, opts = {}) {
        this.api = api;
        if (typeof opts.filter === "string")
            this.filter = opts.filter;
        else {
            const lazy = opts.lazyLoadMembers ?? true;
            this.filter = JSON.stringify(opts.filter ?? {
                room: {
                    state: { lazy_load_members: lazy },
                    timeline: { limit: opts.timelineLimit ?? 20, lazy_load_members: lazy },
                },
            });
        }
    }
    async sync(req) {
        const res = await this.api.request("GET", "/v3/sync", {
            query: { since: req.since, timeout: req.timeoutMs, filter: this.filter, set_presence: req.setPresence },
            signal: req.signal,
            // The server holds the request for up to timeoutMs; allow for the network on top.
            timeoutMs: req.timeoutMs + 30_000,
        });
        return parseV3(res, req.since === undefined);
    }
}
export function parseV3(res, initial) {
    if (typeof res.next_batch !== "string")
        throw new Error("Sync response has no next_batch");
    const rooms = obj(res.rooms);
    const join = {};
    for (const [roomId, r] of Object.entries(obj(rooms.join))) {
        const room = obj(r);
        const summary = obj(room.summary);
        join[roomId] = {
            state: events(room.state),
            initial,
            timeline: timeline(room.timeline),
            ephemeral: events(room.ephemeral),
            accountData: events(room.account_data),
            summary: room.summary
                ? {
                    heroes: arr(summary["m.heroes"]),
                    joinedMemberCount: summary["m.joined_member_count"],
                    invitedMemberCount: summary["m.invited_member_count"],
                }
                : undefined,
            unreadNotifications: room.unread_notifications,
        };
    }
    const invited = (section) => {
        const out = {};
        for (const [roomId, r] of Object.entries(obj(section))) {
            out[roomId] = { strippedState: arr(obj(obj(r).invite_state).events) };
        }
        return out;
    };
    const leave = {};
    for (const [roomId, r] of Object.entries(obj(rooms.leave))) {
        const room = obj(r);
        leave[roomId] = { state: events(room.state), timeline: timeline(room.timeline), accountData: events(room.account_data) };
    }
    const knock = {};
    for (const [roomId, r] of Object.entries(obj(rooms.knock)))
        knock[roomId] = { strippedState: arr(obj(obj(r).knock_state).events) };
    const deviceLists = obj(res.device_lists);
    return {
        nextBatch: res.next_batch,
        rooms: { join, invite: invited(rooms.invite), leave, knock },
        toDevice: arr(obj(res.to_device).events),
        deviceLists: { changed: arr(deviceLists.changed), left: arr(deviceLists.left) },
        oneTimeKeyCounts: res.device_one_time_keys_count,
        unusedFallbackKeyTypes: Array.isArray(res.device_unused_fallback_key_types) ? res.device_unused_fallback_key_types : undefined,
        accountData: events(res.account_data),
        presence: events(res.presence),
    };
}
