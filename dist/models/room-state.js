import { MatrixEvent } from "./event.js";
/** The current state of a room: the latest state event per (type, state_key). */
export class RoomState {
    events = new Map();
    /** For lazy-loaded member lists: whether all members have been fetched once. */
    membersLoaded = false;
    get(type, stateKey = "") {
        return this.events.get(type)?.get(stateKey);
    }
    getAll(type) {
        return [...(this.events.get(type)?.values() ?? [])];
    }
    /** Every state event (for persisting). */
    all() {
        const out = [];
        for (const m of this.events.values())
            out.push(...m.values());
        return out;
    }
    /** Set a state event; returns the event it replaced. */
    set(event) {
        if (event.stateKey === undefined)
            return undefined;
        let m = this.events.get(event.wire.type);
        if (!m)
            this.events.set(event.wire.type, (m = new Map()));
        const previous = m.get(event.stateKey);
        m.set(event.stateKey, event);
        return previous;
    }
    setRaw(raw) {
        return this.set(new MatrixEvent(raw));
    }
    clear() {
        this.events.clear();
        this.membersLoaded = false;
    }
    membership(userId) {
        return this.get("m.room.member", userId)?.content.membership;
    }
    powerLevels() {
        return this.get("m.room.power_levels")?.content ?? {};
    }
    /**
     * A user's power level. Without m.room.power_levels the creator has 100 and everyone else 0
     * (https://spec.matrix.org/v1.16/client-server-api/#mroompower_levels). Room version 12 makes
     * the creators' power infinite; they show as Infinity.
     */
    powerLevel(userId) {
        const create = this.get("m.room.create");
        const version = create?.content.room_version;
        if (version === "12" || (version?.startsWith("org.matrix.hydra") ?? false)) {
            const additional = create?.content?.additional_creators ?? [];
            if (create?.sender === userId || additional.includes(userId))
                return Infinity;
        }
        const pl = this.get("m.room.power_levels")?.content;
        if (!pl)
            return create?.sender === userId || create?.content.creator === userId ? 100 : 0;
        return pl.users?.[userId] ?? pl.users_default ?? 0;
    }
    /** Whether `userId` may send `type` (state or message) by the power levels. */
    maySend(userId, type, state) {
        const pl = this.powerLevels();
        const required = pl.events?.[type] ?? (state ? (this.get("m.room.power_levels") ? (pl.state_default ?? 50) : 0) : (pl.events_default ?? 0));
        return this.powerLevel(userId) >= required;
    }
    members() {
        const events = this.getAll("m.room.member");
        // Disambiguate display names shared by joined or invited members (spec 'Calculating the
        // display name for a user'): "name (@user:server)".
        const counts = new Map();
        for (const e of events) {
            const name = e.content.displayname;
            if (name && (e.content.membership === "join" || e.content.membership === "invite"))
                counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        return events.map((e) => {
            const userId = e.stateKey;
            const raw = typeof e.content.displayname === "string" && e.content.displayname.trim() ? e.content.displayname : undefined;
            const ambiguous = raw !== undefined && (counts.get(raw) ?? 0) > 1;
            // A display name that looks like a user ID is disambiguated too, so nobody can pose as one.
            const looksLikeId = raw !== undefined && raw.startsWith("@") && raw.includes(":");
            return {
                userId,
                membership: e.content.membership,
                rawDisplayName: raw,
                name: raw === undefined ? userId : ambiguous || looksLikeId ? `${raw} (${userId})` : raw,
                avatarUrl: e.content.avatar_url ?? undefined,
                powerLevel: this.powerLevel(userId),
            };
        });
    }
    member(userId) {
        return this.members().find((m) => m.userId === userId);
    }
    isEncrypted() {
        return this.get("m.room.encryption") !== undefined;
    }
}
