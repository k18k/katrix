import { isObject, stringOrUndefined } from "../shared/json.js";
import { M } from "../shared/m.js";
import { evaluatePushRules, pushTweaks } from "../shared/push.js";
import { splitStateKey, toClientEvent } from "./events.js";
import { getState, powerLevels, userLevel } from "./authrules.js";
import { readOnlyRules } from "./pushrules.js";
import { isSubscribed } from "../api/threadsubs.js";
import { upsertMany } from "../storage/batch.js";
import { freeze } from "./changes.js";
// src/core/push.ts
/** Thread an event belongs to for notification purposes ("main" for the main timeline). */
function threadIdOf(event) {
	const rel = event.content?.[M.RELATES_TO];
	return isObject(rel) && rel.rel_type === M.THREAD && typeof rel.event_id === "string" ? rel.event_id : "main";
}
var PushService = class {
	hs;
	constructor(hs) {
		this.hs = hs;
	}
	async onEvent(ev, state, version) {
		const event = ev.pdu;
		const members = [];
		for (const [key, member] of state) {
			const [type, userId] = splitStateKey(key);
			if (type !== M.ROOM.MEMBER) continue;
			const m = member.content?.membership;
			if (m === "join" || m === "invite" && event.type === M.ROOM.MEMBER && event.state_key === userId) members.push(userId);
		}
		const joined = members.filter((u) => getState(state, M.ROOM.MEMBER, u)?.content?.membership === "join");
		const pl = powerLevels(state, version);
		const senderLevel = userLevel(pl, event.sender);
		const thread = threadIdOf(event);
		const notified = [];
		for (const userId of members) {
			if (userId === event.sender || !this.hs.isLocalUser(userId)) continue;
			const rules = await readOnlyRules(this.hs, userId);
			const actions = evaluatePushRules(rules, {
				event,
				userId,
				displayName: stringOrUndefined(getState(state, M.ROOM.MEMBER, userId)?.content?.displayname) ?? null,
				memberCount: joined.length,
				senderLevel: Number.isFinite(senderLevel) ? senderLevel : Number.MAX_SAFE_INTEGER,
				notificationLevels: pl.notifications,
				threadSubscribed: thread === "main" ? void 0 : await isSubscribed(this.hs, userId, event.room_id, thread)
			});
			if (!actions || !actions.includes("notify")) continue;
			const tweaks = pushTweaks(actions);
			notified.push({
				userId,
				tweaks,
				row: {
					user_id: userId,
					room_id: event.room_id,
					event_id: event.event_id,
					stream: ev.stream,
					highlight: tweaks.highlight === true,
					thread_id: thread,
					actions,
					ts: Date.now()
				}
			});
		}
		if (notified.length === 0) return;
		await this.hs.transaction((db) => upsertMany(db, "notifications", notified.map((n) => n.row)));
		const pushers = await this.hs.db.findMany("pushers", { where: [{
			field: "user_id",
			operator: "in",
			value: notified.map((n) => n.userId)
		}] });
		const pushersByUser = Map.groupBy(pushers, (p) => p.user_id);
		for (const n of notified) {
			const own = pushersByUser.get(n.userId);
			if (own) this.deliver(n.userId, ev, state, n.tweaks, own).catch((err) => this.hs.logger.warn("Push delivery failed", err));
		}
	}
	/** Unread notification counts since the user's read receipts. */
	/** Stream positions up to which the user has read the room (unthreaded) and each thread. */
	async readPositions(userId, roomId) {
		const receipts = await this.hs.db.findMany("receipts", { where: [{
			field: "room_id",
			value: roomId
		}, {
			field: "user_id",
			value: userId
		}] });
		let unthreaded = 0;
		const threadRead = /* @__PURE__ */ new Map();
		const readReceipts = receipts.filter((r) => r.receipt_type === M.READ._ || r.receipt_type === M.READ.PRIVATE);
		const targets = await this.hs.rooms.getEvents(readReceipts.map((r) => r.event_id));
		for (const r of readReceipts) {
			const target = targets.get(r.event_id);
			if (!target) continue;
			if (r.thread_id === "") unthreaded = Math.max(unthreaded, target.stream);
			else threadRead.set(r.thread_id, Math.max(threadRead.get(r.thread_id) ?? 0, target.stream));
		}
		return {
			unthreaded,
			threads: threadRead
		};
	}
	isRead(row, read) {
		return row.stream <= read.unthreaded || row.stream <= (read.threads.get(row.thread_id) ?? 0);
	}
	async unreadCounts(userId, roomId) {
		const changes = this.hs.changes;
		if (!changes) return this.countUnread(userId, roomId);
		return changes.values.unreadCounts.get(`${userId}|${roomId}`, async () => freeze(await this.countUnread(userId, roomId)));
	}
	async countUnread(userId, roomId) {
		const read = await this.readPositions(userId, roomId);
		const unthreaded = read.unthreaded;
		const rows = await this.hs.db.findMany("notifications", {
			where: [
				{
					field: "user_id",
					value: userId
				},
				{
					field: "room_id",
					value: roomId
				},
				{
					field: "stream",
					operator: "gt",
					value: unthreaded
				}
			],
			fields: [
				"stream",
				"thread_id",
				"highlight"
			]
		});
		const room = {
			notification_count: 0,
			highlight_count: 0
		};
		const threads = {};
		for (const n of rows) {
			if (this.isRead(n, read)) continue;
			const bucket = n.thread_id === "main" ? room : threads[n.thread_id] ??= {
				notification_count: 0,
				highlight_count: 0
			};
			bucket.notification_count++;
			if (n.highlight) bucket.highlight_count++;
		}
		return {
			room,
			threads
		};
	}
	async deliver(userId, ev, state, tweaks, pushers) {
		const event = ev.pdu;
		const unread = (await this.unreadCounts(userId, event.room_id)).room.notification_count;
		for (const row of pushers) {
			const pusher = row.pusher;
			if (pusher.kind !== "http" || typeof pusher.data?.url !== "string") continue;
			const { url, format, ...data } = pusher.data;
			const notification = {
				event_id: event.event_id,
				room_id: event.room_id,
				counts: { unread },
				devices: [{
					app_id: pusher.app_id,
					pushkey: pusher.pushkey,
					pushkey_ts: Math.floor(Date.now() / 1e3),
					data,
					tweaks
				}],
				prio: tweaks.highlight || tweaks.sound ? "high" : "low"
			};
			if (format !== "event_id_only") {
				notification.type = event.type;
				notification.sender = event.sender;
				notification.content = event.content;
				const name = getState(state, M.ROOM.NAME)?.content?.name;
				if (typeof name === "string") notification.room_name = name;
				const senderName = getState(state, M.ROOM.MEMBER, event.sender)?.content?.displayname;
				if (typeof senderName === "string") notification.sender_display_name = senderName;
				if (event.type === M.ROOM.MEMBER) {
					notification.membership = event.content?.membership;
					notification.user_is_target = event.state_key === userId;
				}
			}
			const res = await this.hs.publicFetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ notification }),
				signal: AbortSignal.timeout(1e4)
			});
			if (!res.ok) {
				this.hs.logger.warn("Push gateway returned", res.status, "for", url);
				continue;
			}
			const body = await res.json().catch(() => ({}));
			if (Array.isArray(body.rejected) && body.rejected.includes(pusher.pushkey)) await this.hs.db.delete("pushers", [
				{
					field: "user_id",
					value: userId
				},
				{
					field: "app_id",
					value: pusher.app_id
				},
				{
					field: "pushkey",
					value: pusher.pushkey
				}
			]);
		}
	}
	/** Rows for `GET /notifications`. */
	async list(userId, opts) {
		const where = [{
			field: "user_id",
			value: userId
		}];
		if (opts.from !== null) where.push({
			field: "stream",
			operator: "lt",
			value: opts.from
		});
		if (opts.onlyHighlight) where.push({
			field: "highlight",
			value: true
		});
		const rows = await this.hs.db.findMany("notifications", {
			where,
			sortBy: {
				field: "stream",
				direction: "desc"
			},
			limit: opts.limit
		});
		const out = [];
		const readByRoom = /* @__PURE__ */ new Map();
		for (const row of rows) {
			const ev = await this.hs.rooms.getEvent(row.event_id);
			if (!ev) continue;
			let read = readByRoom.get(row.room_id);
			if (!read) readByRoom.set(row.room_id, read = await this.readPositions(userId, row.room_id));
			out.push({
				actions: row.actions,
				event: toClientEvent(ev.pdu),
				room_id: row.room_id,
				ts: row.ts,
				read: this.isRead(row, read),
				stream: row.stream
			});
		}
		return out;
	}
};
export { PushService, threadIdOf };

//# sourceMappingURL=push.js.map