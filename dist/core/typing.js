/**
 * Ephemeral typing notifications. Changes are replicated to every instance via the
 * cluster adapter; each instance keeps the typing set in memory.
 */
export class TypingService {
    hs;
    rooms = new Map();
    constructor(hs) {
        this.hs = hs;
        hs.cluster.subscribe("typing", (msg) => this.apply(msg));
    }
    async setTyping(roomId, userId, typing, timeoutMs = 30000) {
        const room = this.rooms.get(roomId);
        const wasTyping = !!room?.users.has(userId);
        if (!typing && !wasTyping)
            return;
        const stream = await this.hs.streams.write(async (id) => id);
        const msg = { roomId, userId, typing, timeoutMs: Math.min(Math.max(timeoutMs, 1000), 120000), stream };
        this.apply(msg);
        await this.hs.cluster.publish("typing", msg);
        this.hs.notifier.notify(await this.hs.rooms.joinedMembers(roomId));
        if ((this.hs.isLocalUser(userId) && typing !== wasTyping) || (typing && this.hs.isLocalUser(userId))) {
            await this.hs.federation.onTyping(roomId, userId, typing).catch(() => { });
        }
    }
    apply(msg) {
        let room = this.rooms.get(msg.roomId);
        if (!room)
            this.rooms.set(msg.roomId, (room = { users: new Map(), stream: 0 }));
        const existing = room.users.get(msg.userId);
        if (existing)
            clearTimeout(existing);
        if (msg.typing) {
            const timer = setTimeout(() => {
                // Expiry is local to each instance; it does not need a new stream position to be visible
                // because typingSince() also reports when users drop out.
                const r = this.rooms.get(msg.roomId);
                if (r?.users.get(msg.userId) === timer) {
                    r.users.delete(msg.userId);
                    r.stream = Math.max(r.stream, msg.stream) + 0.5;
                    void this.hs.rooms
                        .joinedMembers(msg.roomId)
                        .then((m) => this.hs.notifier.notify(m))
                        .catch(() => { });
                }
            }, msg.timeoutMs);
            timer.unref?.();
            room.users.set(msg.userId, timer);
        }
        else {
            room.users.delete(msg.userId);
        }
        room.stream = Math.max(room.stream, msg.stream);
    }
    /** Typing users in a room if they changed after `since` (or always when `since` is null). */
    typingSince(roomId, since) {
        const room = this.rooms.get(roomId);
        if (!room)
            return since === null ? [] : null;
        if (since !== null && room.stream <= since)
            return null;
        return [...room.users.keys()];
    }
}
