import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getFetchHandler } from "#http/adapters.ts";
import type { Homeserver } from "#homeserver.ts";
import { CryptoClient } from "#auditbot/client.ts";
import type { AuditRecord, AuditSink } from "#auditbot/sinks.ts";

// The audit bot: an account of the server that is a member of every room and writes every event
// to an archive, end-to-end encrypted ones decrypted. It is a room member like any other (in the
// member list, with its own device), so everyone can see that a room is recorded; it gets room
// keys the way every member's device does. It runs in the homeserver's process and talks to it
// through its request handler.
//
// What it can and cannot read: messages sent while it is in the room, from clients that share
// room keys with the devices of every member (the default of Element and most clients; a client
// set to "only send to verified devices" skips it). Nothing from before it joined.

export interface AuditBotOptions {
  /** Where the records go: `fileSink(dir)`, or your own. */
  sink: AuditSink;
  /**
   * Directory for the bot's state: its crypto store (room keys, device keys) and the sync
   * position. Losing it loses the keys of encrypted rooms, so keep it on a persistent volume and
   * back it up.
   */
  dataDir: string;
  /** Encrypts the crypto store. Required; keep it with the backups of `dataDir`. */
  storePassphrase: string;
  /** Default "auditbot". */
  localpart?: string;
  /** The bot's name in member lists. Default "Audit log (this room is recorded)". */
  displayName?: string;
  /** "all" rooms, or "groups": not direct messages (rooms created with is_direct). Default "all". */
  rooms?: "all" | "groups";
  /** How often to look for rooms it is not in yet, in ms. Default 10 minutes. */
  sweepIntervalMs?: number;
  /** How long a new room has to be quiet before the bot joins it, in ms. Default 500. */
  joinDelayMs?: number;
  /** How long an undecryptable event waits for its room key before it is recorded as such. Default 1 hour. */
  keyWaitMs?: number;
}

interface PendingEvent {
  roomId: string;
  event: Record<string, any>;
  since: number;
}

interface Saved {
  deviceId: string;
  since?: string;
}

const MAX_PENDING = 10_000;

export interface AuditBot {
  userId: string;
  /** Resolves once the bot has synced up to now (tests). */
  synced(): Promise<void>;
  /** Join every room it is not in yet (it also does this on its own). */
  sweep(): Promise<void>;
  stop(): Promise<void>;
}

export async function startAuditBot(hs: Homeserver, options: AuditBotOptions): Promise<AuditBot> {
  await hs.ready;
  const localpart = options.localpart ?? "auditbot";
  const userId = `@${localpart}:${hs.serverName}`;
  const displayName = options.displayName ?? "Audit log (this room is recorded)";
  await mkdir(options.dataDir, { recursive: true });
  const statePath = join(options.dataDir, "state.json");
  const saved: Saved | null = await readFile(statePath, "utf8").then(JSON.parse, () => null);

  if (!(await hs.admin.getUser(userId))) await hs.admin.createUser(localpart, { displayname: displayName });
  // The crypto store belongs to one device: the bot keeps its device ID across restarts and gets
  // a new access token for it (logging in to the same device keeps its keys).
  const session = await hs.auth.createSession(userId, { deviceId: saved?.deviceId, displayName: "Audit bot" });
  const state: Saved = { deviceId: session.device_id, since: saved?.since };
  const save = () => writeFile(statePath, JSON.stringify(state));
  await save();

  const client = new CryptoClient({ fetch: getFetchHandler(hs), userId, deviceId: session.device_id, accessToken: session.access_token });
  await client.open(join(options.dataDir, "crypto"), options.storePassphrase);
  await client.flush(); // device keys and one-time keys
  await client.ensureCrossSigning();
  await client.request("PUT", `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`, { displayname: displayName });

  const pending: PendingEvent[] = [];
  const recorded = new Set<string>();
  const encryptedRooms = new Set<string>();
  let stopped = false;
  const abort = new AbortController();
  let syncedUpTo = 0;
  const syncWaiters: (() => void)[] = [];

  const isDirect = async (roomId: string) => {
    const state = await hs.rooms.currentState(roomId);
    for (const ev of state.values()) if (ev.type === "m.room.member" && ev.content?.is_direct === true) return true;
    return false;
  };

  const joining = new Map<string, Promise<void>>();
  const ensureJoined = (roomId: string): Promise<void> => {
    const running = joining.get(roomId);
    if (running) return running;
    const p = (async () => {
      if ((await hs.rooms.roomsForUser(userId)).includes(roomId)) return;
      if (options.rooms === "groups" && (await isDirect(roomId))) return;
      try {
        await hs.admin.joinUser(userId, roomId);
        hs.logger.info("Audit bot joined", roomId);
      } catch (err) {
        hs.logger.warn("Audit bot could not join", roomId, (err as Error).message);
      }
    })().finally(() => joining.delete(roomId));
    joining.set(roomId, p);
    return p;
  };

  const sweep = async () => {
    const { rooms } = await hs.admin.listRooms({ limit: 1_000_000 });
    for (const r of rooms) await ensureJoined(r.room_id);
  };

  // New rooms are joined once their creator is in them (the invite needs a member) and the
  // room has been quiet for a moment: createRoom sends its name, settings and invites (including
  // the is_direct one that marks a DM) right after the creator's join.
  const quietTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const joinWhenQuiet = (roomId: string) => {
    clearTimeout(quietTimers.get(roomId));
    quietTimers.set(
      roomId,
      setTimeout(() => {
        quietTimers.delete(roomId);
        void ensureJoined(roomId);
      }, options.joinDelayMs ?? 500),
    );
  };
  const onEvent = (ev: Record<string, any>) => {
    if (stopped || ev.type !== "m.room.member" || ev.state_key === userId) return;
    if (ev.content?.membership === "join") joinWhenQuiet(ev.room_id);
    // A room that turns out to be a DM after the bot joined it.
    if (options.rooms === "groups" && ev.content?.is_direct === true)
      void (async () => {
        if (!(await hs.rooms.joinedMembers(ev.room_id)).includes(userId)) return;
        await client.request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(ev.room_id)}/leave`, {}).catch(() => {});
        hs.logger.info("Audit bot left a direct message room", ev.room_id);
      })();
  };
  hs.on("event", onEvent);

  const toRecord = (roomId: string, ev: Record<string, any>, extra: Partial<AuditRecord> = {}): AuditRecord => ({
    recorded_at: Date.now(),
    room_id: roomId,
    event_id: ev.event_id,
    type: ev.type,
    sender: ev.sender,
    origin_server_ts: ev.origin_server_ts,
    ...(ev.state_key !== undefined ? { state_key: ev.state_key } : {}),
    content: ev.content ?? {},
    ...(ev.redacts ? { redacts: ev.redacts } : {}),
    encrypted: false,
    ...extra,
  });

  /** A record for an event, decrypting it when it is encrypted; null when its key is not here yet. */
  const process = async (roomId: string, ev: Record<string, any>): Promise<AuditRecord | null> => {
    if (ev.type !== "m.room.encrypted") return toRecord(roomId, ev);
    try {
      const decrypted = await client.decrypt(ev, roomId);
      const clear = JSON.parse(decrypted.event) as Record<string, any>;
      return toRecord(
        roomId,
        { ...ev, type: clear.type, content: clear.content },
        { encrypted: true, sender_device: decrypted.senderDevice?.toString() },
      );
    } catch {
      return null;
    }
  };

  const write = async (records: AuditRecord[]) => {
    const fresh = records.filter((r) => !recorded.has(r.event_id));
    if (fresh.length === 0) return;
    await options.sink.write(fresh);
    for (const r of fresh) recorded.add(r.event_id);
    if (recorded.size > 100_000) recorded.clear();
  };

  const retryPending = async () => {
    const out: AuditRecord[] = [];
    const keyWait = options.keyWaitMs ?? 3600_000;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      const record = await process(p.roomId, p.event);
      if (record || Date.now() - p.since > keyWait) {
        out.push(record ?? toRecord(p.roomId, p.event, { encrypted: true, decryption_error: "The room key did not reach the audit bot" }));
        pending.splice(i, 1);
      }
    }
    await write(out.reverse());
  };

  const handleSync = async (sync: Record<string, any>) => {
    await client.receiveSync(sync);
    const out: AuditRecord[] = [];
    for (const [roomId, room] of Object.entries<Record<string, any>>(sync.rooms?.join ?? {})) {
      const timeline: Record<string, any>[] = room.timeline?.events ?? [];
      const stateEvents: Record<string, any>[] = room.state?.events ?? [];
      for (const ev of [...stateEvents, ...timeline]) {
        if (ev.type === "m.room.encryption") encryptedRooms.add(roomId);
      }
      // A room seen for the first time: its members' devices, so room keys can reach the bot
      // and be trusted (and its state at that point, as part of the record).
      if (encryptedRooms.has(roomId) && (stateEvents.length || timeline.some((e) => e.type === "m.room.member"))) {
        await client.track(await hs.rooms.joinedMembers(roomId));
      }
      for (const ev of stateEvents) out.push(toRecord(roomId, ev, { initial_state: true }));
      for (const ev of timeline) {
        const record = await process(roomId, ev);
        if (record) out.push(record);
        else if (pending.length < MAX_PENDING) pending.push({ roomId, event: ev, since: Date.now() });
      }
    }
    await write(out);
    await retryPending();
  };

  const loop = async () => {
    while (!stopped) {
      try {
        const params = new URLSearchParams({ timeout: "30000", filter: JSON.stringify({ room: { timeline: { limit: 200 } } }) });
        if (state.since) params.set("since", state.since);
        const sync = await client.request("GET", `/_matrix/client/v3/sync?${params}`, undefined, abort.signal);
        await handleSync(sync);
        state.since = sync.next_batch;
        await save();
        syncedUpTo = Date.now();
        for (const w of syncWaiters.splice(0)) w();
      } catch (err) {
        if (stopped) return;
        hs.logger.warn("Audit bot sync failed", (err as Error).message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };

  await sweep();
  const running = loop();
  const timer = setInterval(() => void sweep().catch(() => {}), options.sweepIntervalMs ?? 600_000);
  timer.unref();

  return {
    userId,
    sweep,
    synced() {
      const asked = Date.now();
      return new Promise<void>((resolve) => {
        const check = () => (syncedUpTo > asked ? resolve() : syncWaiters.push(check));
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
    },
  };
}
