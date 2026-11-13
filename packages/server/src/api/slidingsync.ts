import { M, stringOrUndefined, UNSTABLE } from "@katrix/shared";
import { MatrixError } from "#core/errors.ts";
import { longPoll } from "#api/longpoll.ts";
import { getState } from "#core/authrules.ts";
import { splitStateKey, toClientEvent, type ClientEvent, type PDU } from "#core/events.ts";
import type { Session } from "#core/auth.ts";
import type { Homeserver } from "#homeserver.ts";
import type { Router } from "#http/router.ts";
import type { WhereClause } from "#storage/types.ts";
import { procedure, type ProcedureContext } from "#http/procedure.ts";
import { v } from "#core/vpm.ts";
import { body as bodySchema, lenient } from "#http/input.ts";
import { roomEphemeral, roomTimeline, toStripped, type SyncParams } from "#api/sync.ts";

/**
 * Simplified sliding sync (MSC4186), as used by Element X.
 * Connection state (which rooms a client already has, and with which config) is kept in the
 * database so that clients survive restarts.
 */

const THREAD_SUBSCRIPTIONS = UNSTABLE.IO.ELEMENT.MSC4308.THREAD_SUBSCRIPTIONS;

// https://github.com/k18k/katrix/issues/128: only the top level of the body was checked; lists, subscriptions and
// extensions were cast to their types and read as `any`. The whole request is described here, and
// malformed parts are ignored rather than refused, as before.
const roomConfig = {
  /** Pairs of event type and state key. */
  required_state: lenient(v.array(v.array(v.string()))),
  timeline_limit: lenient(v.number()),
};
const roomSubscription = v.object(roomConfig);
const listConfig = v.object({
  ...roomConfig,
  /** Pairs of first and last index. */
  ranges: lenient(v.array(v.array(v.number()))),
  filters: lenient(
    v.object({
      is_dm: lenient(v.boolean()),
      is_invite: lenient(v.boolean()),
      is_encrypted: lenient(v.boolean()),
      spaces: lenient(v.array(v.string())),
      room_types: lenient(v.array(v.string().nullable())),
      not_room_types: lenient(v.array(v.string().nullable())),
    }),
  ),
});
const extension = lenient(v.object({ enabled: lenient(v.boolean()) }));
const extensionsConfig = v.object({
  to_device: lenient(v.object({ enabled: lenient(v.boolean()), since: lenient(v.string()), limit: lenient(v.number()) })),
  e2ee: extension,
  account_data: extension,
  receipts: extension,
  typing: extension,
  [THREAD_SUBSCRIPTIONS]: lenient(v.object({ enabled: lenient(v.boolean()), limit: lenient(v.number()) })),
});
const slidingSyncBody = bodySchema({
  conn_id: lenient(v.string()),
  lists: lenient(v.record(v.string(), lenient(listConfig))),
  room_subscriptions: lenient(v.record(v.string(), lenient(roomSubscription))),
  extensions: lenient(extensionsConfig),
});

/** A room of the response. Invites and knocks carry stripped state and no counts. */
interface RoomResponse {
  bump_stamp: number;
  timeline: ClientEvent[];
  required_state: ClientEvent[];
  initial?: true;
  name?: string;
  avatar?: string;
  is_dm?: true;
  invite_state?: ReturnType<typeof toStripped>[];
  knock_state?: ReturnType<typeof toStripped>[];
  num_live?: number;
  limited?: boolean;
  prev_batch?: string;
  heroes?: { user_id: string; displayname?: string; avatar_url?: string }[];
  joined_count?: number;
  invited_count?: number;
  notification_count?: number;
  highlight_count?: number;
}

interface ConnectionState {
  /** Rooms already sent: a key of the config they were sent with, and their last counts. */
  rooms: Record<string, { config: string; counts: string }>;
  prevPos: number | null;
  toDeviceSince: number;
}

const BUMP_TYPES = new Set([M.ROOM.CREATE, M.ROOM.MESSAGE, M.ROOM.ENCRYPTED, M.STICKER, M.CALL.INVITE, M.POLL.START, M.BEACON_INFO]);

async function loadConnection(hs: Homeserver, s: Session, connId: string) {
  return hs.db.findOne("sliding_sync_connections", [
    { field: "user_id", value: s.userId },
    { field: "device_id", value: s.deviceId },
    { field: "conn_id", value: connId },
  ]);
}

/** Stream position of the latest "interesting" event in a room. */
async function bumpStamp(hs: Homeserver, roomId: string, upTo: number): Promise<number> {
  const rows = await hs.db.findMany("events", {
    where: [
      { field: "room_id", value: roomId },
      { field: "stream", operator: "lte", value: upTo },
    ],
    sortBy: { field: "stream", direction: "desc" },
    limit: 50,
  });
  for (const r of rows) if (BUMP_TYPES.has(r.type)) return r.stream;
  return rows[rows.length - 1]?.stream ?? 0;
}

function matchesRequiredState(required: string[][], type: string, key: string, userId: string, lazyMembers: Set<string>): boolean {
  for (const [t, k] of required) {
    if (t !== "*" && t !== type) continue;
    if (k === "*" || k === key) return true;
    if (k === "$ME" && key === userId) return true;
    if (k === "$LAZY" && type === M.ROOM.MEMBER && lazyMembers.has(key)) return true;
  }
  return false;
}

export function registerSlidingSyncRoutes(r: Router): void {
  r.post(
    "/_matrix/client/unstable/org.matrix.simplified_msc3575/sync",
    procedure({ auth: "user", input: slidingSyncBody, handler: slidingSync }),
  );
  r.post("/_matrix/client/v5/sync", procedure({ auth: "user", input: slidingSyncBody, handler: slidingSync }));
}

async function slidingSync(ctx: ProcedureContext<"user", v.output<typeof slidingSyncBody>>) {
  const hs = ctx.hs;
  const s = ctx.session;
  const body = ctx.input;
  const connId = body.conn_id ?? "";
  const posParam = ctx.query.get("pos");
  const timeout = Math.min(Math.max(Number.parseInt(ctx.query.get("timeout") ?? "0", 10) || 0, 0), hs.config.maxSyncTimeoutMs);

  let conn: ConnectionState = { rooms: {}, prevPos: null, toDeviceSince: 0 };
  let since: number | null = null;
  if (posParam !== null) {
    const row = await loadConnection(hs, s, connId);
    const pos = Number(posParam);
    // Clients may retry the previous request, so both the current and the previous position are valid.
    if (!row || !Number.isInteger(pos) || (pos !== row.pos && pos !== row.state.prevPos)) {
      throw new MatrixError(400, "M_UNKNOWN_POS", "Unknown position; start a new connection");
    }
    conn = row.state;
    since = pos;
    if (pos === row.state.prevPos && pos !== row.pos) {
      // A retry: forget rooms sent in the response that was lost.
      conn = { ...conn, rooms: {} };
    }
  }

  // The long-poll loop is shared with /sync (#50).
  const { value, to, aborted } = await longPoll(hs, s.userId, timeout, ctx.request.signal, async (to) => {
    const built = await buildResponse(hs, s, body, conn, since, to);
    return { value: built, done: since === null || !built.empty };
  });
  if (aborted && value.empty) return { pos: String(since), lists: {}, rooms: {}, extensions: {} };
  await hs.db.upsert("sliding_sync_connections", {
    user_id: s.userId,
    device_id: s.deviceId,
    conn_id: connId,
    pos: to,
    state: { ...value.next, prevPos: since },
    updated_ts: Date.now(),
  });
  return { pos: String(to), ...value.response };
}

async function buildResponse(
  hs: Homeserver,
  s: Session,
  body: v.output<typeof slidingSyncBody>,
  conn: ConnectionState,
  since: number | null,
  to: number,
) {
  const userId = s.userId;
  const memberships = await hs.db.findMany("memberships", { where: [{ field: "user_id", value: userId }] });
  const direct = await hs.db.findOne("account_data", [
    { field: "user_id", value: userId },
    { field: "room_id", value: "" },
    { field: "type", value: M.DIRECT },
  ]);
  const dmRooms = new Set<string>(
    Object.values(direct?.content ?? {})
      .flat()
      .filter((x): x is string => typeof x === "string"),
  );

  // Candidate rooms: current memberships, plus rooms left since the last request.
  const candidates = memberships.filter(
    (m) => m.stream <= to && (["join", "invite", "knock"].includes(m.membership) || (since !== null && m.stream > since && !m.forgotten)),
  );

  interface RoomInfo {
    roomId: string;
    membership: string;
    bump: number;
    state: Map<string, PDU>;
  }
  const infos: RoomInfo[] = [];
  for (const m of candidates) {
    const state = await hs.rooms.currentState(m.room_id);
    const bump = m.membership === "join" ? await bumpStamp(hs, m.room_id, to) : m.stream;
    infos.push({ roomId: m.room_id, membership: m.membership, bump, state });
    const invite = getState(state, M.ROOM.MEMBER, userId);
    if (m.membership === "invite" && invite?.content?.is_direct) dmRooms.add(m.room_id);
  }
  infos.sort((a, b) => b.bump - a.bump);

  // Lists → rooms in view, with the config each room should be sent with.
  const wanted = new Map<string, v.output<typeof roomSubscription>>();
  const lists: Record<string, { count: number }> = {};
  for (const [name, list = {}] of Object.entries(body.lists ?? {})) {
    const f = list.filters ?? {};
    let rooms = infos;
    if (f.is_dm !== undefined) rooms = rooms.filter((r) => dmRooms.has(r.roomId) === f.is_dm);
    if (f.is_invite !== undefined) rooms = rooms.filter((r) => (r.membership === "invite") === f.is_invite);
    if (f.is_encrypted !== undefined) rooms = rooms.filter((r) => !!getState(r.state, M.ROOM.ENCRYPTION) === f.is_encrypted);
    const roomType = (r: RoomInfo) => stringOrUndefined(getState(r.state, M.ROOM.CREATE)?.content?.type) ?? null;
    if (f.room_types) rooms = rooms.filter((r) => f.room_types!.includes(roomType(r)));
    if (f.not_room_types) rooms = rooms.filter((r) => !f.not_room_types!.includes(roomType(r)));
    if (f.spaces) {
      const children = new Set<string>();
      for (const space of f.spaces) {
        if (!(await hs.rooms.exists(space))) continue;
        for (const key of (await hs.rooms.currentState(space)).keys()) {
          const [t, k] = splitStateKey(key);
          if (t === M.SPACE.CHILD) children.add(k);
        }
      }
      rooms = rooms.filter((r) => children.has(r.roomId));
    }
    lists[name] = { count: rooms.length };
    for (const [start, end] of list.ranges ?? [[0, rooms.length - 1]]) {
      for (const room of rooms.slice(Math.max(0, start), Math.max(0, end) + 1)) {
        const prev = wanted.get(room.roomId);
        wanted.set(room.roomId, mergeConfig({ a: prev, b: list }));
      }
    }
  }
  for (const [roomId, subscription = {}] of Object.entries(body.room_subscriptions ?? {})) {
    const info = infos.find((i) => i.roomId === roomId);
    if (!info) {
      // Subscriptions to rooms we are not in are allowed for world-readable rooms.
      if (!(await hs.rooms.exists(roomId)) || !(await hs.rooms.canPeek(roomId, userId)).worldReadable) continue;
      infos.push({ roomId, membership: "leave", bump: 0, state: await hs.rooms.currentState(roomId) });
    }
    wanted.set(roomId, mergeConfig({ a: wanted.get(roomId), b: subscription }));
  }

  const next: ConnectionState = { rooms: { ...conn.rooms }, prevPos: conn.prevPos, toDeviceSince: conn.toDeviceSince };
  const rooms: Record<string, RoomResponse> = {};
  for (const [roomId, config] of wanted) {
    const info = infos.find((i) => i.roomId === roomId)!;
    const configKey = JSON.stringify(config);
    const known = since !== null ? conn.rooms[roomId] : undefined;
    const initial = !known || known.config !== configKey;
    const room = await buildRoom(hs, s, info, config, initial ? null : since, to, dmRooms.has(roomId));
    const counts = JSON.stringify([room.notification_count, room.highlight_count, room.joined_count, room.invited_count]);
    if (!initial && room.timeline.length === 0 && room.required_state.length === 0 && known!.counts === counts) continue;
    if (initial) room.initial = true;
    rooms[roomId] = room;
    next.rooms[roomId] = { config: configKey, counts };
  }

  const extensions = await buildExtensions({ hs, s, ext: body.extensions ?? {}, since, to, roomIds: Object.keys(rooms), next });
  const empty = Object.keys(rooms).length === 0 && isEmptyExtensions(extensions);
  return { response: { lists, rooms, extensions }, empty, next };
}

function mergeConfig({ a, b }: { a: v.output<typeof roomSubscription> | undefined; b: v.output<typeof roomSubscription> }) {
  if (!a) return { required_state: b.required_state ?? [], timeline_limit: b.timeline_limit ?? 0 };
  return {
    required_state: [...(a.required_state ?? []), ...(b.required_state ?? [])],
    timeline_limit: Math.max(a.timeline_limit ?? 0, b.timeline_limit ?? 0),
  };
}

async function buildRoom(
  hs: Homeserver,
  s: Session,
  info: { roomId: string; membership: string; bump: number; state: Map<string, PDU> },
  config: v.output<typeof roomSubscription>,
  since: number | null,
  to: number,
  isDm: boolean,
) {
  const { roomId, state } = info;
  const userId = s.userId;
  const room: RoomResponse = { bump_stamp: info.bump, timeline: [], required_state: [] };
  const name = getState(state, M.ROOM.NAME)?.content?.name;
  if (typeof name === "string") room.name = name;
  const avatar = getState(state, M.ROOM.AVATAR)?.content?.url;
  if (typeof avatar === "string") room.avatar = avatar;
  if (isDm) room.is_dm = true;

  if (info.membership === "invite" || info.membership === "knock") {
    const own = getState(state, M.ROOM.MEMBER, userId);
    const ev = own?.event_id ? await hs.rooms.getEvent(own.event_id) : null;
    if (ev) {
      const key = info.membership === "invite" ? "invite_room_state" : "knock_room_state";
      room[info.membership === "invite" ? "invite_state" : "knock_state"] = [...(ev.pdu.unsigned?.[key] ?? []), ev.pdu].map(toStripped);
    }
    return room;
  }

  // Timeline (reuses /sync's visibility-aware pagination).
  const p: SyncParams = {
    session: s,
    ignored: new Set(),
    since: since === null ? null : { pos: since, toDevice: 0 },
    to,
    filter: { room: { timeline: { limit: config.timeline_limit ?? 0 } } },
    fullState: false,
  };
  const upTo =
    info.membership === "join"
      ? to
      : Math.min(
          to,
          (
            await hs.db.findOne("memberships", [
              { field: "room_id", value: roomId },
              { field: "user_id", value: userId },
            ])
          )?.stream ?? to,
        );
  if ((config.timeline_limit ?? 0) > 0) {
    const { timeline, timelineEvents } = await roomTimeline(hs, p, roomId, since, upTo);
    room.timeline = timeline.events.map((e) => ({ ...e, room_id: undefined }));
    // https://github.com/k18k/katrix/issues/129: num_live was counted by the caller from a __stream field added to each event and
    // deleted again; it is counted here, where the stream positions are known.
    if (since !== null) room.num_live = timelineEvents.filter((e) => e.stream > since).length;
    room.limited = timeline.limited;
    room.prev_batch = timeline.prev_batch;
  }

  // Required state: everything matching for initial rooms; changed entries otherwise.
  const lazy = new Set([userId, ...room.timeline.map((e) => e.sender)]);
  const required = config.required_state ?? [];
  for (const [key, ev] of state) {
    const [type, sk] = splitStateKey(key);
    if (!matchesRequiredState(required, type, sk, userId, lazy)) continue;
    if (since !== null) {
      const stored = ev.event_id ? await hs.rooms.getEvent(ev.event_id) : null;
      if (!stored || stored.stream <= since) continue;
    }
    room.required_state.push(toClientEvent(ev, { includeRoomId: false }));
  }

  // Heroes and counts.
  let joined = 0;
  let invited = 0;
  const heroes: NonNullable<RoomResponse["heroes"]> = [];
  for (const [key, ev] of state) {
    const [type, sk] = splitStateKey(key);
    if (type !== M.ROOM.MEMBER) continue;
    const m = ev.content?.membership;
    if (m === "join") joined++;
    if (m === "invite") invited++;
    if ((m === "join" || m === "invite") && sk !== userId && heroes.length < 5) {
      heroes.push({
        user_id: sk,
        displayname: stringOrUndefined(ev.content?.displayname),
        avatar_url: stringOrUndefined(ev.content?.avatar_url),
      });
    }
  }
  room.joined_count = joined;
  room.invited_count = invited;
  if (!room.name) room.heroes = heroes;
  const counts = await hs.push.unreadCounts(userId, roomId);
  room.notification_count = counts.room.notification_count + Object.values(counts.threads).reduce((n, t) => n + t.notification_count, 0);
  room.highlight_count = counts.room.highlight_count + Object.values(counts.threads).reduce((n, t) => n + t.highlight_count, 0);
  return room;
}

interface ExtensionParams {
  hs: Homeserver;
  s: Session;
  ext: v.output<typeof extensionsConfig>;
  since: number | null;
  to: number;
  /** The rooms of this response. */
  roomIds: string[];
  next: ConnectionState;
}

async function buildExtensions(p: ExtensionParams) {
  const { ext } = p;
  const ephemeral = ext.receipts?.enabled || ext.typing?.enabled ? await ephemeralExtensions(p) : undefined;
  return {
    ...(ext.to_device?.enabled ? { to_device: await toDeviceExtension(p) } : {}),
    ...(ext.e2ee?.enabled ? { e2ee: await e2eeExtension(p) } : {}),
    ...(ext.account_data?.enabled ? { account_data: await accountDataExtension(p) } : {}),
    ...(ext[THREAD_SUBSCRIPTIONS]?.enabled ? { [THREAD_SUBSCRIPTIONS]: await threadSubscriptions(p) } : {}),
    ...(ephemeral && ext.receipts?.enabled ? { receipts: { rooms: ephemeral.receipts } } : {}),
    ...(ephemeral && ext.typing?.enabled ? { typing: { rooms: ephemeral.typing } } : {}),
  };
}

/** Deletes the messages the client acknowledged with `since`, then returns the next ones. */
async function toDeviceExtension({ hs, s, ext, to, next }: ExtensionParams) {
  const where = [
    { field: "user_id", value: s.userId },
    { field: "device_id", value: s.deviceId },
  ];
  const ackUpTo = Number(ext.to_device?.since ?? next.toDeviceSince) || 0;
  if (ackUpTo) await hs.db.delete("to_device", [...where, { field: "stream", operator: "lte", value: ackUpTo }]);
  const rows = (
    await hs.db.findMany("to_device", {
      where: [...where, { field: "stream", operator: "gt", value: ackUpTo }],
      sortBy: { field: "stream", direction: "asc" },
      limit: Math.min(ext.to_device?.limit || 100, 1000),
    })
  ).filter((r) => r.stream <= to);
  const nextBatch: number = rows.length ? rows[rows.length - 1].stream : ackUpTo;
  next.toDeviceSince = nextBatch;
  return { next_batch: String(nextBatch), events: rows.map((r) => ({ sender: r.sender, type: r.type, content: r.content })) };
}

async function e2eeExtension({ hs, s, since, to }: ExtensionParams) {
  return {
    device_one_time_keys_count: await hs.keys.oneTimeKeyCounts(s.userId, s.deviceId),
    device_unused_fallback_key_types: await hs.keys.unusedFallbackKeyTypes(s.userId, s.deviceId),
    ...(since !== null ? { device_lists: await hs.keys.changesSince(s.userId, since, to) } : {}),
  };
}

async function accountDataExtension({ hs, s, since, to, roomIds }: ExtensionParams) {
  const where: WhereClause[] = [{ field: "user_id", value: s.userId }];
  if (since !== null) where.push({ field: "stream", operator: "gt", value: since });
  const rows = (await hs.db.findMany("account_data", { where })).filter((r) => r.stream <= to);
  const global: { type: string; content: unknown }[] = [];
  const rooms: Record<string, typeof global> = {};
  for (const r of rows) {
    const ev = { type: r.type, content: r.content };
    if (r.room_id === "") global.push(ev);
    else if (roomIds.includes(r.room_id) || since !== null) (rooms[r.room_id] ??= []).push(ev);
  }
  if (since === null && !global.some((e) => e.type === M.PUSH_RULES)) {
    const { readOnlyRules } = await import("#core/pushrules.ts");
    global.push({ type: M.PUSH_RULES, content: { global: await readOnlyRules(hs, s.userId) } });
  }
  return { global, rooms };
}

async function threadSubscriptions({ hs, s, ext, since, to }: ExtensionParams) {
  const { threadSubscriptionsExtension } = await import("#api/threadsubs.ts");
  return threadSubscriptionsExtension(hs, s.userId, ext[THREAD_SUBSCRIPTIONS] ?? {}, since, to);
}

/** The receipt and typing events of the joined rooms, by room. */
async function ephemeralExtensions({ hs, s, since, to, roomIds }: ExtensionParams) {
  const p = {
    session: s,
    ignored: new Set(),
    since: since === null ? null : { pos: since, toDevice: 0 },
    to,
    filter: {},
    fullState: false,
  } satisfies SyncParams;
  const joined = new Set(await hs.rooms.roomsForUser(s.userId));
  const receipts: Record<string, { type: string; content: object }> = {};
  const typing: typeof receipts = {};
  for (const roomId of since === null ? roomIds : [...joined]) {
    if (!joined.has(roomId)) continue;
    // A typing event is only there when it has news: on an initial sync, when someone types.
    for (const e of await roomEphemeral(hs, p, roomId)) {
      if (e.type === M.RECEIPT) receipts[roomId] = e;
      if (e.type === M.TYPING) typing[roomId] = e;
    }
  }
  return { receipts, typing };
}

/** Nothing in the extensions that a waiting client has to be woken for. */
function isEmptyExtensions(e: Awaited<ReturnType<typeof buildExtensions>>) {
  const byRoom = [e.account_data?.rooms, e.receipts?.rooms, e.typing?.rooms];
  if (e.to_device?.events.length || e.account_data?.global.length) return false;
  if (e.e2ee?.device_lists?.changed.length || e.e2ee?.device_lists?.left.length) return false;
  return byRoom.every((rooms) => !rooms || Object.keys(rooms).length === 0);
}
