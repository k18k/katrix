import { getFetchHandler } from "../http/adapters.js";
import { isObject } from "../packages/shared/src/json.js";
import { CryptoClient } from "./client.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
// src/auditbot/bot.ts
function isRoomEvent(ev) {
	return typeof ev.event_id === "string" && typeof ev.sender === "string" && typeof ev.origin_server_ts === "number";
}
const MAX_PENDING = 1e4;
async function startAuditBot(hs, options) {
	await hs.ready;
	const localpart = options.localpart ?? "auditbot";
	const userId = `@${localpart}:${hs.serverName}`;
	const displayName = options.displayName ?? "Audit log (this room is recorded)";
	await mkdir(options.dataDir, { recursive: true });
	const statePath = join(options.dataDir, "state.json");
	const saved = await readFile(statePath, "utf8").then(JSON.parse, () => null);
	if (!await hs.admin.getUser(userId)) await hs.admin.createUser(localpart, { displayname: displayName });
	const session = await hs.auth.createSession(userId, {
		deviceId: saved?.deviceId,
		displayName: "Audit bot"
	});
	const state = {
		deviceId: session.device_id,
		since: saved?.since
	};
	const save = () => writeFile(statePath, JSON.stringify(state));
	await save();
	const client = new CryptoClient({
		fetch: getFetchHandler(hs),
		userId,
		deviceId: session.device_id,
		accessToken: session.access_token
	});
	await client.open(join(options.dataDir, "crypto"), options.storePassphrase);
	await client.flush();
	await client.ensureCrossSigning();
	await client.request("PUT", `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`, { displayname: displayName });
	const pending = [];
	const recorded = /* @__PURE__ */ new Set();
	const encryptedRooms = /* @__PURE__ */ new Set();
	let stopped = false;
	const abort = new AbortController();
	let syncedUpTo = 0;
	const syncWaiters = [];
	const isDirect = async (roomId) => {
		const state = await hs.rooms.currentState(roomId);
		for (const ev of state.values()) if (ev.type === "m.room.member" && ev.content?.is_direct === true) return true;
		return false;
	};
	const joining = /* @__PURE__ */ new Map();
	const ensureJoined = (roomId) => {
		const running = joining.get(roomId);
		if (running) return running;
		const p = (async () => {
			if ((await hs.rooms.roomsForUser(userId)).includes(roomId)) return;
			if (options.rooms === "groups" && await isDirect(roomId)) return;
			try {
				await hs.admin.joinUser(userId, roomId);
				hs.logger.info("Audit bot joined", roomId);
			} catch (err) {
				hs.logger.warn("Audit bot could not join", roomId, err.message);
			}
		})().finally(() => joining.delete(roomId));
		joining.set(roomId, p);
		return p;
	};
	const sweep = async () => {
		const { rooms } = await hs.admin.listRooms({ limit: 1e6 });
		for (const r of rooms) await ensureJoined(r.room_id);
	};
	const quietTimers = /* @__PURE__ */ new Map();
	const joinWhenQuiet = (roomId) => {
		clearTimeout(quietTimers.get(roomId));
		quietTimers.set(roomId, setTimeout(() => {
			quietTimers.delete(roomId);
			ensureJoined(roomId);
		}, options.joinDelayMs ?? 500));
	};
	const onEvent = (ev) => {
		if (stopped || ev.type !== "m.room.member" || ev.state_key === userId || !ev.room_id) return;
		const roomId = ev.room_id;
		if (ev.content?.membership === "join") joinWhenQuiet(roomId);
		if (options.rooms === "groups" && ev.content?.is_direct === true) (async () => {
			if (!(await hs.rooms.joinedMembers(roomId)).includes(userId)) return;
			await client.request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {}).catch((err) => hs.logger.warn("Audit bot failed to leave a direct message room", err));
			hs.logger.info("Audit bot left a direct message room", roomId);
		})();
	};
	hs.on("event", onEvent);
	const toRecord = (roomId, ev, extra = {}) => ({
		recorded_at: Date.now(),
		room_id: roomId,
		event_id: ev.event_id,
		type: ev.type,
		sender: ev.sender,
		origin_server_ts: ev.origin_server_ts,
		...ev.state_key !== void 0 ? { state_key: ev.state_key } : {},
		content: ev.content ?? {},
		...ev.redacts ? { redacts: ev.redacts } : {},
		encrypted: false,
		...extra
	});
	/** A record for an event, decrypting it when it is encrypted; null when its key is not here yet. */
	const process = async (roomId, ev) => {
		if (ev.type !== "m.room.encrypted") return toRecord(roomId, ev);
		try {
			const decrypted = await client.decrypt(ev, roomId);
			const clear = JSON.parse(decrypted.event);
			if (!isObject(clear) || typeof clear.type !== "string" || !isObject(clear.content)) return null;
			return toRecord(roomId, {
				...ev,
				type: clear.type,
				content: clear.content
			}, {
				encrypted: true,
				sender_device: decrypted.senderDevice?.toString()
			});
		} catch {
			return null;
		}
	};
	const write = async (records) => {
		const fresh = records.filter((r) => !recorded.has(r.event_id));
		if (fresh.length === 0) return;
		await options.sink.write(fresh);
		for (const r of fresh) recorded.add(r.event_id);
		if (recorded.size > 1e5) recorded.clear();
	};
	const retryPending = async () => {
		const out = [];
		const keyWait = options.keyWaitMs ?? 36e5;
		for (let i = pending.length - 1; i >= 0; i--) {
			const p = pending[i];
			const record = await process(p.roomId, p.event);
			if (record || Date.now() - p.since > keyWait) {
				out.push(record ?? toRecord(p.roomId, p.event, {
					encrypted: true,
					decryption_error: "The room key did not reach the audit bot"
				}));
				pending.splice(i, 1);
			}
		}
		await write(out.reverse());
	};
	const handleSync = async (sync) => {
		await client.receiveSync(sync);
		const out = [];
		for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
			const timeline = (room.timeline?.events ?? []).filter(isRoomEvent);
			const stateEvents = (room.state?.events ?? []).filter(isRoomEvent);
			for (const ev of [...stateEvents, ...timeline]) if (ev.type === "m.room.encryption") encryptedRooms.add(roomId);
			if (encryptedRooms.has(roomId) && (stateEvents.length || timeline.some((e) => e.type === "m.room.member"))) await client.track(await hs.rooms.joinedMembers(roomId));
			for (const ev of stateEvents) out.push(toRecord(roomId, ev, { initial_state: true }));
			for (const ev of timeline) {
				const record = await process(roomId, ev);
				if (record) out.push(record);
				else if (pending.length < MAX_PENDING) pending.push({
					roomId,
					event: ev,
					since: Date.now()
				});
			}
		}
		await write(out);
		await retryPending();
	};
	const loop = async () => {
		while (!stopped) try {
			const params = new URLSearchParams({
				timeout: "30000",
				filter: JSON.stringify({ room: { timeline: { limit: 200 } } })
			});
			if (state.since) params.set("since", state.since);
			const sync = await client.request("GET", `/_matrix/client/v3/sync?${params}`, void 0, abort.signal);
			await handleSync(sync);
			state.since = sync.next_batch;
			await save();
			syncedUpTo = Date.now();
			for (const w of syncWaiters.splice(0)) w();
		} catch (err) {
			if (stopped) return;
			hs.logger.warn("Audit bot sync failed", err.message);
			await new Promise((r) => setTimeout(r, 5e3));
		}
	};
	await sweep();
	const running = loop();
	const timer = setInterval(() => void sweep().catch((err) => hs.logger.warn("Audit bot sweep failed", err)), options.sweepIntervalMs ?? 6e5);
	timer.unref();
	return {
		userId,
		sweep,
		synced() {
			const asked = Date.now();
			return new Promise((resolve) => {
				const check = () => syncedUpTo > asked ? resolve() : syncWaiters.push(check);
				check();
			});
		},
		async stop() {
			stopped = true;
			abort.abort();
			clearInterval(timer);
			for (const t of quietTimers.values()) clearTimeout(t);
			hs.off("event", onEvent);
			await running.catch(() => {});
			client.close();
		}
	};
}
export { startAuditBot };

//# sourceMappingURL=bot.js.map