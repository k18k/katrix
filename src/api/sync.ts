import { errors } from "#core/errors.ts";
import { getState } from "#core/authrules.ts";
import { eventIdOf, splitStateKey, stateKey, toClientEvent, type PDU } from "#core/events.ts";
import type { StoredEvent } from "#core/rooms.ts";
import type { Session } from "#core/auth.ts";
import type { Homeserver } from "#homeserver.ts";
import type { BatchQuery, Row } from "#storage/types.ts";
import { readBatch } from "#storage/batch.ts";
import { Semaphore } from "#core/semaphore.ts";
import { deviceListChangesQuery } from "#core/keys.ts";
import type { RequestContext, Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import { body } from "#http/input.ts";
import { matchesFilter, roomAllowed, validateSyncFilter, type SyncFilter } from "#api/filters.ts";
import { readOnlyRules } from "#core/pushrules.ts";
import { fullProfile } from "#core/profile.ts";
import { inviteDecision } from "#core/invitefilter.ts";
import { M, UNSTABLE } from "#core/m.ts";

interface SyncToken {
  pos: number;
  toDevice: number;
  /**
   * The response with this token delivered to-device messages, so a sync with it acknowledges
   * them. https://github.com/k18k/matrix-nodejs-homeserver/issues/42: every sync ran the delete,
   * though almost none had anything to acknowledge. Deletes cover all positions up to `toDevice`,
   * so messages delivered under an unmarked token go with the next acknowledgement.
   */
  ack?: boolean;
}

function parseSyncToken(raw: string | null): SyncToken | null {
  if (!raw) return null;
  const m = /^s(\d+)(?:_(\d+))?(_a)?$/.exec(raw);
  if (!m) throw errors.invalidParam("Invalid since token");
  return { pos: Number(m[1]), toDevice: Number(m[2] ?? m[1]), ack: !!m[3] };
}

const formatToken = (t: SyncToken) => `s${t.pos}_${t.toDevice}${t.ack ? "_a" : ""}`;

async function loadFilter(hs: Homeserver, userId: string, raw: string | null): Promise<SyncFilter> {
  if (!raw) return {};
  if (raw.trim().startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw errors.badJson("Invalid filter JSON");
    }
    return validateSyncFilter(parsed);
  }
  const row = await hs.db.findOne("filters", [
    { field: "user_id", value: userId },
    { field: "filter_id", value: raw },
  ]);
  if (!row) throw errors.notFound("Unknown filter");
  return row.filter as SyncFilter;
}

/** A stripped state event as clients expect it. */
export function toStripped(ev: Record<string, any>): Record<string, any> {
  return { type: ev.type, state_key: ev.state_key, sender: ev.sender, content: ev.content };
}

export interface SyncParams {
  session: Session;
  /**
   * MSC4222: return the state at the end of the timeline instead of `state`, under the
   * key matching the parameter the client used: `state_after` for the stable
   * `use_state_after`, `org.matrix.msc4222.state_after` for the unstable
   * `org.matrix.msc4222.use_state_after` (which matrix-js-sdk and Element send, and read
   * back only under the unstable key).
   */
  useStateAfter?: boolean;
  stateAfterKey?: "state_after" | typeof UNSTABLE.ORG.MATRIX.MSC4222.STATE_AFTER;
  ignored: Set<string>;
  since: SyncToken | null;
  to: number;
  filter: SyncFilter;
  fullState: boolean;
}

/** State snapshot ID in effect at stream position `pos` in a room (0 = empty). */
async function snapshotAt(hs: Homeserver, roomId: string, pos: number): Promise<number> {
  const rows = await hs.db.findMany("events", {
    where: [
      { field: "room_id", value: roomId },
      { field: "stream", operator: "lte", value: pos },
    ],
    sortBy: { field: "stream", direction: "desc" },
    limit: 1,
    // Only the snapshot ID: the event's JSON is not needed here (https://github.com/k18k/matrix-nodejs-homeserver/issues/33).
    fields: ["state_snapshot"],
  });
  return rows[0]?.state_snapshot ?? 0;
}

/** Build the timeline + state section of a room. */
export async function roomTimeline(
  hs: Homeserver,
  p: SyncParams,
  roomId: string,
  since: number | null,
  upTo: number,
): Promise<{ timeline: Record<string, any>; state: PDU[]; stateAfter: PDU[]; timelineEvents: StoredEvent[] }> {
  const tf = p.filter.room?.timeline;
  const limit = tf?.limit ?? 10;
  const where: any[] = [
    { field: "room_id", value: roomId },
    { field: "stream", operator: "lte", value: upTo },
  ];
  if (since !== null) where.push({ field: "stream", operator: "gt", value: since });
  // https://github.com/k18k/matrix-nodejs-homeserver/issues/38: the state the client had at the
  // token does not depend on the timeline, so it is read alongside it rather than after it.
  const sinceIdsRead = since !== null ? snapshotAt(hs, roomId, since).then((id) => hs.rooms.snapshotIds(id)) : Promise.resolve({});
  // Every row read while walking the timeline, newest first and without gaps in (since, upTo]:
  // the state snapshots at the timeline's end and start come from these when they can.
  const scanned: Row[] = [];
  const events: StoredEvent[] = [];
  let limited = false;
  let cursor = upTo;
  const batchSize = Math.max(limit * 2, 20);
  // Walk backwards until we have `limit` visible, filtered events.
  for (;;) {
    const w = where.map((c) => (c.field === "stream" && c.operator === "lte" ? { ...c, value: cursor } : c));
    const rows = await hs.db.findMany("events", { where: w, sortBy: { field: "stream", direction: "desc" }, limit: batchSize });
    if (rows.length === 0) break;
    scanned.push(...rows);
    const stored = rows.map((r) => hs.rooms.rowToStored(r));
    const visible = await hs.rooms.filterVisible(p.session.userId, roomId, stored);
    const ok = new Map(visible.map((v) => [v.pdu.event_id, v]));
    let full = false;
    for (const raw of stored) {
      cursor = raw.stream - 1;
      const ev = ok.get(raw.pdu.event_id);
      if (!ev || !matchesFilter(tf, ev.pdu) || p.ignored.has(ev.pdu.sender)) continue;
      // Initial syncs order the timeline topologically (as Synapse does), so gather some slack
      // beyond `limit` from the stream to choose the topologically latest events from.
      if (events.length >= (since === null ? limit * 2 : limit)) {
        limited = true;
        full = true;
        break;
      }
      events.push(ev);
    }
    if (full || rows.length < batchSize) break;
  }
  if (since === null && events.length > limit) {
    events.sort((a, b) => (b.pdu.depth ?? 0) - (a.pdu.depth ?? 0) || b.stream - a.stream);
    events.length = limit;
    limited = true;
  }
  if (limit === 0 && events.length === 0) {
    const more = await hs.db.findMany("events", { where, limit: 1, fields: ["stream"] });
    limited = more.length > 0;
  }
  if (since === null) events.sort((a, b) => (a.pdu.depth ?? 0) - (b.pdu.depth ?? 0) || a.stream - b.stream);
  else events.reverse();
  // A gap (unfetched predecessors) inside the timeline: start the timeline at the newest
  // gap event and mark it limited, so the client paginates across the gap.
  let lastGap = -1;
  events.forEach((e, i) => {
    if (e.gap) lastGap = i;
  });
  if (lastGap >= 0) {
    events.splice(0, lastGap);
    limited = true;
  }
  const startPos = events.length ? Math.min(...events.map((e) => e.stream)) - 1 : upTo;
  // #38: the newest event at or before a position, with its state snapshot. The timeline walk read
  // the room's events from `upTo` down without gaps, so a scanned row answers it when one is old
  // enough; only otherwise is it a query.
  const newestAtOrBefore = async (pos: number): Promise<{ stream: number; state_snapshot: number } | null> => {
    const row = scanned.find((r) => r.stream <= pos);
    if (row) return row as { stream: number; state_snapshot: number };
    const rows = await hs.db.findMany("events", {
      where: [
        { field: "room_id", value: roomId },
        { field: "stream", operator: "lte", value: pos },
      ],
      sortBy: { field: "stream", direction: "desc" },
      limit: 1,
      // Only the snapshot ID: the event's JSON is not needed here (https://github.com/k18k/matrix-nodejs-homeserver/issues/33).
      fields: ["stream", "state_snapshot"],
    });
    return (rows[0] as { stream: number; state_snapshot: number } | undefined) ?? null;
  };
  const [atStart, atEnd] = await Promise.all([newestAtOrBefore(startPos), startPos === upTo ? null : newestAtOrBefore(upTo)]);
  const startSnapshot = atStart?.state_snapshot ?? 0;
  const endSnapshot = startPos === upTo ? startSnapshot : (atEnd?.state_snapshot ?? 0);
  if (!limited && events.length) {
    // Earlier events exist (even if not visible to us): the timeline is incomplete. When the
    // timeline's first event is also its earliest in the stream, the event found for its start
    // state answers this too (#38).
    if (events[0].stream === startPos + 1) limited = atStart !== null && (since === null || atStart.stream > since);
    else {
      const before = await hs.db.findMany("events", {
        where: [...where.filter((c) => c.operator !== "lte"), { field: "stream", operator: "lt", value: events[0].stream }],
        limit: 1,
        fields: ["stream"],
      });
      limited = before.length > 0;
    }
  }

  // State section (as Synapse computes it): state at the timeline's start, plus state at its
  // end that the timeline does not itself carry, minus what the client already had at `since`.
  // The end-state part covers state changes on forks merged into the timeline.
  const [startState, endState] = await Promise.all([hs.rooms.stateAtSnapshot(startSnapshot), hs.rooms.stateAtSnapshot(endSnapshot)]);
  const timelineIds = new Set(events.map((e) => e.pdu.event_id));
  for (const [key, ev] of endState) {
    if (timelineIds.has(ev.event_id) || startState.get(key)?.event_id === ev.event_id) continue;
    if (events.some((e) => e.pdu.state_key !== undefined && stateKey(e.pdu.type, e.pdu.state_key) === key)) continue;
    startState.set(key, ev);
  }
  const sinceIds: Record<string, string> = await sinceIdsRead;
  const sf = p.filter.room?.state;
  const lazy = !!sf?.lazy_load_members;
  const senders = new Set(events.map((e) => e.pdu.sender));
  senders.add(p.session.userId);
  const state: PDU[] = [];
  for (const [key, ev] of startState) {
    if (sinceIds[key] === ev.event_id) continue;
    const [type, sk] = splitStateKey(key);
    if (!matchesFilter(sf, ev)) continue;
    if (lazy && type === M.ROOM.MEMBER && !senders.has(sk)) continue;
    state.push(ev);
  }
  if (lazy) {
    // Partial-state rooms (MSC3902) may not know a sender's membership yet: use the one the
    // event itself was authorised by.
    for (const e of events) {
      const key = stateKey(M.ROOM.MEMBER, e.pdu.sender);
      if (startState.has(key) || state.some((s) => s.type === M.ROOM.MEMBER && s.state_key === e.pdu.sender)) continue;
      const auth = await hs.rooms.getPdus((e.pdu.auth_events ?? []).map(eventIdOf));
      const member = [...auth.values()].find((a) => a.type === M.ROOM.MEMBER && a.state_key === e.pdu.sender);
      if (member && matchesFilter(sf, member)) state.push(member);
    }
  }
  // MSC4222: state at the end of the timeline, relative to what the client had at `since`.
  const stateAfter: PDU[] = [];
  if (p.useStateAfter) {
    for (const [key, ev] of endState) {
      if (sinceIds[key] === ev.event_id) continue;
      const [type, sk] = splitStateKey(key);
      if (!matchesFilter(sf, ev)) continue;
      if (lazy && type === M.ROOM.MEMBER && !senders.has(sk)) continue;
      stateAfter.push(ev);
    }
  }
  return {
    stateAfter,
    timeline: {
      events: events.map((e) => hs.rooms.formatEvent(e, p.session, { includeRoomId: false })),
      limited,
      prev_batch: `s${startPos}`,
    },
    state,
    timelineEvents: events,
  };
}

export async function roomEphemeral(hs: Homeserver, p: SyncParams, roomId: string, prefetched?: Row[]): Promise<Record<string, any>[]> {
  const since = p.since?.pos ?? null;
  const out: { type: string; content: Record<string, any> }[] = [];
  const typing = hs.typing.typingSince(roomId, since);
  if (typing !== null && (since !== null || typing.length > 0)) out.push({ type: M.TYPING, content: { user_ids: typing } });
  const where: any[] = [{ field: "room_id", value: roomId }];
  if (since !== null) where.push({ field: "stream", operator: "gt", value: since });
  const receipts = (prefetched ?? (await hs.db.findMany("receipts", { where }))).filter((r) => r.stream <= p.to);
  const content: Record<string, any> = {};
  for (const r of receipts) {
    if (r.receipt_type === M.READ.PRIVATE && r.user_id !== p.session.userId) continue;
    content[r.event_id] ??= {};
    content[r.event_id][r.receipt_type] ??= {};
    // MSC4102: when receipts clash on one event, the unthreaded one wins.
    if (r.thread_id && content[r.event_id][r.receipt_type][r.user_id] && !content[r.event_id][r.receipt_type][r.user_id].thread_id)
      continue;
    content[r.event_id][r.receipt_type][r.user_id] = { ts: r.ts, ...(r.thread_id ? { thread_id: r.thread_id } : {}) };
  }
  if (Object.keys(content).length) out.push({ type: M.RECEIPT, content });
  return out.filter((e) => matchesFilter(p.filter.room?.ephemeral, e));
}

async function accountData(hs: Homeserver, p: SyncParams, roomId: string, prefetched?: Row[]): Promise<{ type: string; content: any }[]> {
  const where: any[] = [
    { field: "user_id", value: p.session.userId },
    { field: "room_id", value: roomId },
  ];
  if (p.since && !p.fullState) where.push({ field: "stream", operator: "gt", value: p.since.pos });
  const rows = prefetched ?? (await hs.db.findMany("account_data", { where }));
  const filter = roomId ? p.filter.room?.account_data : p.filter.account_data;
  // Account data "deleted" by setting empty content is omitted from initial syncs.
  return rows
    .filter((r) => r.stream <= p.to && (p.since || Object.keys(r.content ?? {}).length > 0))
    .map((r) => ({ type: r.type as string, content: r.content }))
    .filter((e) => matchesFilter(filter, e));
}

export async function roomSummary(hs: Homeserver, roomId: string, userId: string): Promise<Record<string, any>> {
  const state = await hs.rooms.currentState(roomId);
  let joined = 0;
  let invited = 0;
  const heroes: string[] = [];
  for (const [key, ev] of state) {
    const [type, sk] = splitStateKey(key);
    if (type !== M.ROOM.MEMBER) continue;
    const m = ev.content?.membership;
    if (m === "join") joined++;
    if (m === "invite") invited++;
    if ((m === "join" || m === "invite") && sk !== userId && heroes.length < 5) heroes.push(sk);
  }
  const summary: Record<string, any> = { [M.JOINED_MEMBER_COUNT]: joined, [M.INVITED_MEMBER_COUNT]: invited };
  if (!getState(state, M.ROOM.NAME)?.content?.name && !getState(state, M.ROOM.CANONICAL_ALIAS)?.content?.alias) {
    summary[M.HEROES] = heroes.sort();
  }
  return summary;
}

/**
 * What changed for the user since the token, for all of their rooms at once: the rooms with new
 * events or newly complete state, and the new receipts and account data by room.
 *
 * https://github.com/k18k/matrix-nodejs-homeserver/issues/33: an incremental sync queried every
 * joined room (timeline, receipts, account data) and only then found that most had nothing new,
 * so a sync cost as many queries as the user had rooms, each time a long-poll woke up. These few
 * queries find the rooms that changed, and only those are built.
 */
/** One-time key counts by algorithm, as /sync reports them (signed_curve25519 always present). */
function countAlgorithms(rows: Row[]): Record<string, number> {
  const counts: Record<string, number> = { signed_curve25519: 0 };
  for (const r of rows) counts[r.algorithm] = (counts[r.algorithm] ?? 0) + 1;
  return counts;
}

async function changesSince(
  hs: Homeserver,
  p: SyncParams,
  memberships: Row[],
  since: number,
  accountRows: Row[],
): Promise<{ touched: Set<string>; receipts: Map<string, Row[]>; accountData: Map<string, Row[]>; memberChanges: Row[] }> {
  const joined = memberships.filter((m) => m.membership === "join").map((m) => m.room_id as string);
  const anyMembership = [...new Set(memberships.map((m) => m.room_id as string))];
  const range = [
    { field: "stream", operator: "gt" as const, value: since },
    { field: "stream", operator: "lte" as const, value: p.to },
  ];
  // https://github.com/k18k/matrix-nodejs-homeserver/issues/34: these reads go to the database
  // together. IN lists are chunked, so a user in thousands of rooms stays within parameter limits.
  const chunks = <T>(list: T[]) => Array.from({ length: Math.ceil(list.length / 500) }, (_, i) => list.slice(i * 500, i * 500 + 500));
  const inRooms = (chunk: string[]) => ({ field: "room_id", operator: "in" as const, value: chunk });
  const queries: BatchQuery[] = [];
  for (const chunk of chunks(joined)) {
    queries.push({ model: "events", opts: { where: [inRooms(chunk), ...range], fields: ["room_id"] } });
    queries.push({ model: "receipts", opts: { where: [inRooms(chunk), ...range] } });
    // Rooms whose state became complete are sent again as if newly joined (MSC3902).
    queries.push({
      model: "partial_state_rooms",
      opts: { where: [inRooms(chunk), { field: "completed_stream", operator: "gt", value: since }], fields: ["room_id"] },
    });
  }
  // Membership changes in the user's rooms (presence, profiles and device lists use them).
  for (const chunk of chunks(anyMembership))
    queries.push({ model: "memberships", opts: { where: [inRooms(chunk), { field: "stream", operator: "gt", value: since }] } });
  const results = await readBatch(hs.db, queries);
  const touched = new Set<string>();
  const receipts = new Map<string, Row[]>();
  const joinedChunks = Math.ceil(joined.length / 500);
  for (let c = 0; c < joinedChunks; c++) {
    const [events, receiptRows, completed] = results.slice(c * 3, c * 3 + 3);
    for (const r of events) touched.add(r.room_id);
    for (const r of receiptRows) {
      touched.add(r.room_id);
      receipts.set(r.room_id, [...(receipts.get(r.room_id) ?? []), r]);
    }
    for (const r of completed) touched.add(r.room_id);
  }
  const memberChanges = results.slice(joinedChunks * 3).flat();
  const accountData = new Map<string, Row[]>();
  for (const r of accountRows) {
    if (r.room_id) touched.add(r.room_id);
    accountData.set(r.room_id, [...(accountData.get(r.room_id) ?? []), r]);
  }
  return { touched, receipts, accountData, memberChanges };
}

/** How many of a sync's joined rooms are built at once (#38). */
const JOINED_ROOMS_AT_ONCE = 8;

/** `fn` over `items` with at most `limit` running at once; results in input order. */
async function mapConcurrently<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function buildSync(hs: Homeserver, p: SyncParams): Promise<{ body: Record<string, any>; empty: boolean; nextToDevice: number }> {
  const userId = p.session.userId;
  const since = p.since?.pos ?? null;
  const incremental = since !== null && !p.fullState;
  const deviceWhere = [
    { field: "user_id", value: userId },
    { field: "device_id", value: p.session.deviceId },
  ];
  // https://github.com/k18k/matrix-nodejs-homeserver/issues/34: the reads that need only the user
  // and the token, in one round trip. Acknowledging to-device messages (a delete of positions up
  // to the previous token) runs alongside: it touches none of the rows read here.
  const acknowledged = p.since?.ack
    ? hs.db.delete("to_device", [...deviceWhere, { field: "stream", operator: "lte", value: p.since.toDevice }])
    : Promise.resolve(0);
  const [memberships, ignoredRows, toDeviceRows, oneTimeKeyRows, fallbackRows, accountRows = []] = await readBatch(hs.db, [
    { model: "memberships", opts: { where: [{ field: "user_id", value: userId }] } },
    {
      model: "account_data",
      opts: {
        where: [
          { field: "user_id", value: userId },
          { field: "room_id", value: "" },
          { field: "type", value: M.IGNORED_USER_LIST },
        ],
      },
    },
    {
      model: "to_device",
      opts: {
        where: [...deviceWhere, { field: "stream", operator: "gt", value: p.since?.toDevice ?? 0 }],
        sortBy: { field: "stream", direction: "asc" },
        limit: 100,
      },
    },
    { model: "one_time_keys", opts: { where: [...deviceWhere, { field: "fallback", value: false }], fields: ["algorithm"] } },
    { model: "fallback_keys", opts: { where: [...deviceWhere, { field: "used", value: false }], fields: ["algorithm"] } },
    ...(incremental
      ? [
          {
            model: "account_data",
            opts: {
              where: [
                { field: "user_id", value: userId },
                { field: "stream", operator: "gt" as const, value: since },
              ],
            },
          },
        ]
      : []),
  ]);
  p = { ...p, ignored: new Set(Object.keys(ignoredRows[0]?.content?.ignored_users ?? {})) };
  const changes = incremental ? await changesSince(hs, p, memberships, since, accountRows) : null;
  // Membership changes since the token in the user's rooms: needed for presence, profiles and
  // device lists alike, so read once for this request.
  let memberChangesRead: Promise<Row[]> | null = changes ? Promise.resolve(changes.memberChanges) : null;
  const memberChanges = () => (memberChangesRead ??= hs.rooms.membershipChangesSince(userId, since ?? 0, memberships));
  const join: Record<string, any> = {};
  const invite: Record<string, any> = {};
  const leave: Record<string, any> = {};
  const knock: Record<string, any> = {};
  let empty = true;
  const joinedBuilds: Row[] = [];

  for (const m of memberships) {
    if (m.stream > p.to || !roomAllowed(p.filter, m.room_id)) continue;
    const roomId = m.room_id;
    const changed = since === null || m.stream > since;

    if (m.membership === "join") {
      // Nothing new in this room since the token: leave it out without asking the database.
      if (changes && !changed && !changes.touched.has(roomId) && hs.typing.typingSince(roomId, since) === null) continue;
      joinedBuilds.push(m);
    } else if (m.membership === "invite") {
      if (!changed && !p.fullState) continue;
      // Invites to rooms on other servers are stored as outliers.
      const pdu = await hs.rooms.getPdu(m.event_id);
      if (!pdu || p.ignored.has(pdu.sender)) continue;
      if ((await inviteDecision(hs, userId, pdu.sender)) !== "allow") continue;
      // Clients get stripped state events only (type, state_key, sender, content).
      const stripped = [...(pdu.unsigned?.invite_room_state ?? []), pdu].map(toStripped);
      invite[roomId] = { invite_state: { events: stripped } };
      empty = false;
    } else if (m.membership === "knock") {
      if (!changed && !p.fullState) continue;
      const knockPdu = await hs.rooms.getPdu(m.event_id);
      const ev = knockPdu ? { pdu: knockPdu } : null;
      if (!ev) continue;
      knock[roomId] = { knock_state: { events: [...(ev.pdu.unsigned?.knock_room_state ?? []), ev.pdu].map(toStripped) } };
      empty = false;
    } else {
      // leave or ban
      if (m.forgotten && since === null) continue;
      if (since === null ? !p.filter.room?.include_leave : m.stream <= since) continue;
      const { timeline, state } = await roomTimeline(hs, p, roomId, since, m.stream);
      // Leaves of rooms we never joined (e.g. rejected remote invites) are outliers.
      const tf = p.filter.room?.timeline;
      if (!(await hs.rooms.exists(roomId)) && (tf?.limit ?? 10) > 0 && !timeline.events.some((e: any) => e.event_id === m.event_id)) {
        const leavePdu = await hs.rooms.getPdu(m.event_id);
        if (leavePdu && matchesFilter(tf, leavePdu)) timeline.events.push(toClientEvent(leavePdu, { includeRoomId: false }));
      }
      leave[roomId] = {
        timeline,
        state: { events: state.map((e) => toClientEvent(e, { includeRoomId: false })) },
        account_data: { events: await accountData(hs, p, roomId, changes ? (changes.accountData.get(roomId) ?? []) : undefined) },
      };
      empty = false;
    }
  }

  // https://github.com/k18k/matrix-nodejs-homeserver/issues/38: the changed rooms were built one
  // after another, each with its reads in sequence, so a sync took as many round trips as its
  // rooms had reads. They are built concurrently now (a few at a time, so an initial sync of many
  // rooms does not take the whole database pool), and a room's independent reads run together.
  const joinedRoom = async (m: Row): Promise<Record<string, any> | null> => {
    const roomId: string = m.room_id;
    // MSC3902: without lazy-loaded members the room is withheld until its full state is known,
    // and then sent as if newly joined.
    if (!p.filter.room?.state?.lazy_load_members && (await hs.partialState.isPartial(roomId))) return null;
    const completedAt = await hs.partialState.completedAt(roomId);
    const initial =
      since === null || p.fullState || m.stream > since || (completedAt !== null && completedAt > since && completedAt <= p.to);
    const [{ timeline, state, stateAfter, timelineEvents }, ephemeral, roomAccountData, summary, counts] = await Promise.all([
      roomTimeline(hs, p, roomId, initial ? null : since, p.to),
      roomEphemeral(hs, p, roomId, changes ? (changes.receipts.get(roomId) ?? []) : undefined),
      accountData(hs, p, roomId, changes ? (changes.accountData.get(roomId) ?? []) : undefined),
      roomSummary(hs, roomId, userId),
      hs.push.unreadCounts(userId, roomId),
    ]);
    if (
      !initial &&
      timelineEvents.length === 0 &&
      state.length === 0 &&
      stateAfter.length === 0 &&
      ephemeral.length === 0 &&
      roomAccountData.length === 0
    )
      return null;
    const stateSection = p.useStateAfter
      ? { [p.stateAfterKey ?? "state_after"]: { events: stateAfter.map((e) => toClientEvent(e, { includeRoomId: false })) } }
      : { state: { events: state.map((e) => toClientEvent(e, { includeRoomId: false })) } };
    const room: Record<string, any> = {
      timeline,
      ...stateSection,
      ephemeral: { events: ephemeral },
      account_data: { events: roomAccountData },
      summary,
    };
    if (p.filter.room?.timeline?.unread_thread_notifications) {
      room.unread_notifications = counts.room;
      if (Object.keys(counts.threads).length) room.unread_thread_notifications = counts.threads;
    } else {
      // Without thread-aware clients, thread notifications count towards the room.
      const total = { ...counts.room };
      for (const t of Object.values(counts.threads)) {
        total.notification_count += t.notification_count;
        total.highlight_count += t.highlight_count;
      }
      room.unread_notifications = total;
    }
    return room;
  };
  const built = await mapConcurrently(joinedBuilds, JOINED_ROOMS_AT_ONCE, joinedRoom);
  joinedBuilds.forEach((m, i) => {
    if (!built[i]) return;
    join[m.room_id] = built[i];
    empty = false;
  });

  const globalAccountData = await accountData(hs, p, "", changes ? (changes.accountData.get("") ?? []) : undefined);
  if (since === null && !globalAccountData.some((e) => e.type === M.PUSH_RULES)) {
    globalAccountData.push({ type: M.PUSH_RULES, content: { global: await readOnlyRules(hs, userId) } });
  }
  if (globalAccountData.length) empty = false;

  // To-device: everything up to the previous token is acknowledged (above); deliver new messages.
  await acknowledged;
  const toDevice = toDeviceRows.filter((r) => r.stream <= p.to);
  const nextToDevice = toDevice.length ? toDevice[toDevice.length - 1].stream : (p.since?.toDevice ?? 0);
  if (toDevice.length) empty = false;

  // Presence for users sharing rooms, and (incrementally) device-list changes: one batch (#34).
  const presenceEvents: Record<string, any>[] = [];
  const wantPresence = !p.filter.presence?.types || p.filter.presence.types.length > 0;
  const sharing = await hs.rooms.usersSharingRooms(userId);
  const joinedRooms = memberships.filter((m) => m.membership === "join").map((m) => m.room_id as string);
  // Users we started sharing a room with since the last sync get their presence sent regardless of age.
  const newlyShared = new Set<string>();
  if (since !== null && wantPresence) {
    const myRooms = new Set(joinedRooms);
    for (const c of await memberChanges()) {
      if (c.membership !== "join" || !myRooms.has(c.room_id)) continue;
      if (c.user_id === userId) for (const u of await hs.rooms.joinedMembers(c.room_id)) newlyShared.add(u);
      else newlyShared.add(c.user_id);
    }
  }
  const sharingList = [...sharing];
  const [presenceRows = [], newlySharedPresence = [], deviceRows] = await readBatch(hs.db, [
    // Initially everyone's presence; afterwards only what changed since the token (presence rarely
    // changes, so this is usually nothing, where it used to be a row per user in the user's rooms).
    {
      model: "presence",
      opts: {
        where: [
          { field: "user_id", operator: "in", value: wantPresence ? sharingList : [] },
          ...(since !== null ? [{ field: "stream", operator: "gt" as const, value: since }] : []),
        ],
      },
    },
    { model: "presence", opts: { where: [{ field: "user_id", operator: "in", value: [...newlyShared] }] } },
    ...(since !== null ? [{ model: "device_list_changes", opts: deviceListChangesQuery(sharing, since) }] : []),
  ]);
  if (wantPresence) {
    const seen = new Set<string>();
    for (const row of [...presenceRows, ...newlySharedPresence]) {
      if (seen.has(row.user_id)) continue;
      seen.add(row.user_id);
      if (row.stream > p.to) continue;
      const content: Record<string, any> = { presence: row.presence, last_active_ago: Date.now() - row.last_active_ts };
      if (row.status_msg) content.status_msg = row.status_msg;
      if (row.presence === "online") content.currently_active = true;
      const ev = { type: M.PRESENCE, sender: row.user_id, content };
      if (matchesFilter(p.filter.presence, ev)) presenceEvents.push(ev);
    }
  }
  if (presenceEvents.length) empty = false;

  const profileUpdates = await profileUpdatesFor(hs, p, memberships, memberChanges);
  if (profileUpdates) empty = false;

  const body: Record<string, any> = {
    next_batch: formatToken({ pos: p.to, toDevice: nextToDevice, ack: toDevice.length > 0 }),
    // Empty sections are omitted, as clients (and Synapse) expect.
    rooms: Object.fromEntries(Object.entries({ join, invite, leave, knock }).filter(([, v]) => Object.keys(v).length)),
    presence: { events: presenceEvents },
    account_data: { events: globalAccountData },
    to_device: { events: toDevice.map((r) => ({ sender: r.sender, type: r.type, content: r.content })) },
    device_one_time_keys_count: countAlgorithms(oneTimeKeyRows),
    device_unused_fallback_key_types: [...new Set(fallbackRows.map((r) => r.algorithm as string))],
  };
  if (profileUpdates) body[UNSTABLE.ORG.MATRIX.MSC4429.USERS] = profileUpdates;
  if (since !== null) {
    const lists = await hs.keys.changesSince(userId, since, p.to, { memberChanges: await memberChanges(), deviceRows, joinedRooms });
    body.device_lists = lists;
    if (lists.changed.length || lists.left.length) empty = false;
  }
  return { body, empty, nextToDevice };
}

// https://github.com/k18k/matrix-nodejs-homeserver/issues/35: a message wakes every member's
// /sync at once, and each queued its reads for the database pool together, ahead of any send or
// join that arrived meanwhile. Only maxConcurrentSyncs responses are built at once per process;
// the others wait here, which costs nothing, and other requests keep getting connections.
const slots = new WeakMap<Homeserver, Semaphore>();
function syncSlots(hs: Homeserver): Semaphore {
  let s = slots.get(hs);
  if (!s) slots.set(hs, (s = new Semaphore(hs.config.maxConcurrentSyncs)));
  return s;
}

async function sync(ctx: RequestContext) {
  const hs = ctx.hs;
  const session = await ctx.auth();
  const filter = await loadFilter(hs, session.userId, ctx.query.get("filter"));
  const since = parseSyncToken(ctx.query.get("since"));
  const fullState = ctx.query.get("full_state") === "true";
  const timeout = Math.min(Math.max(Number.parseInt(ctx.query.get("timeout") ?? "0", 10) || 0, 0), hs.config.maxSyncTimeoutMs);
  const setPresence = ctx.query.get("set_presence") ?? "online";
  if (setPresence !== "offline") await touchPresence(hs, session.userId, setPresence);

  const deadline = Date.now() + timeout;
  for (;;) {
    const to = await hs.streams.position();
    // buildSync reads the ignored-users list with its other reads (#34).
    const ignored = new Set<string>();
    const stable = ctx.query.get("use_state_after") === "true";
    const unstable = ctx.query.get(UNSTABLE.ORG.MATRIX.MSC4222.USE_STATE_AFTER) === "true";
    const useStateAfter = stable || unstable;
    const stateAfterKey = stable ? "state_after" : UNSTABLE.ORG.MATRIX.MSC4222.STATE_AFTER;
    const { body, empty } = await syncSlots(hs).run(() =>
      buildSync(hs, { session, ignored, since, to, filter, fullState, useStateAfter, stateAfterKey }),
    );
    const remaining = deadline - Date.now();
    if (!since || !empty || remaining <= 0 || fullState) return body;
    // Something happened while we were building the response: rebuild immediately.
    if ((await hs.streams.position()) > to) continue;
    await hs.notifier.wait(session.userId, remaining, ctx.request.signal);
    if (ctx.request.signal?.aborted) return body;
  }
}

// https://github.com/k18k/matrix-nodejs-homeserver/issues/26: last_active_ts was written on every
// /sync, i.e. once per request of every online user, and those writes took about half of the
// event loop under load. It only feeds last_active_ago, which the spec calls approximate, so it is
// refreshed at most once a minute (Synapse's granularity too).
const LAST_ACTIVE_GRANULARITY_MS = 60_000;

async function touchPresence(hs: Homeserver, userId: string, presence: string): Promise<void> {
  const state = presence === "unavailable" ? "unavailable" : "online";
  const row = await hs.db.findOne("presence", [{ field: "user_id", value: userId }]);
  if (row && row.presence === state) {
    if (Date.now() - row.last_active_ts >= LAST_ACTIVE_GRANULARITY_MS)
      await hs.db.update("presence", [{ field: "user_id", value: userId }], { last_active_ts: Date.now() });
    return;
  }
  await hs.streams.write((stream) =>
    hs.db.upsert("presence", { user_id: userId, presence: state, status_msg: row?.status_msg ?? null, last_active_ts: Date.now(), stream }),
  );
  await hs.federation.onPresence(userId, state, row?.status_msg ?? null).catch(() => {});
}

export function registerSyncRoutes(r: Router): void {
  r.client("GET", "/sync", procedure({ handler: sync }));

  // Filters are checked by validateSyncFilter, shared with filters given inline to /sync.
  r.client(
    "POST",
    "/user/:userId/filter",
    procedure({
      auth: "user",
      input: body({}),
      handler: async (ctx) => {
        const s = ctx.session;
        if (ctx.params.userId !== s.userId) throw errors.forbidden("Cannot create filters for other users");
        const filter = validateSyncFilter(ctx.input);
        const existing = await ctx.hs.db.findMany("filters", { where: [{ field: "user_id", value: s.userId }] });
        const filterId = String(existing.reduce((max, f) => Math.max(max, Number(f.filter_id) || 0), 0) + 1);
        await ctx.hs.db.create("filters", { user_id: s.userId, filter_id: filterId, filter });
        return { filter_id: filterId };
      },
    }),
  );

  r.client(
    "GET",
    "/user/:userId/filter/:filterId",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        if (ctx.params.userId !== s.userId) throw errors.forbidden("Cannot read filters of other users");
        const row = await ctx.hs.db.findOne("filters", [
          { field: "user_id", value: s.userId },
          { field: "filter_id", value: ctx.params.filterId },
        ]);
        if (!row) throw errors.notFound("Unknown filter");
        return row.filter;
      },
    }),
  );
}

/**
 * MSC4429: profile changes of users sharing a room, limited to the fields the filter asks for.
 * The initial sync carries current values; users we no longer share any room with get `null`.
 */
async function profileUpdatesFor(
  hs: Homeserver,
  p: SyncParams,
  memberships: Record<string, any>[],
  memberChanges: () => Promise<Row[]>,
): Promise<Record<string, any> | null> {
  const ids = (p.filter.profile_fields ?? p.filter[UNSTABLE.ORG.MATRIX.MSC4429.PROFILE_FIELDS])?.ids;
  if (!Array.isArray(ids) || !ids.length) return null;
  const wanted = new Set(ids.filter((x) => typeof x === "string"));
  const since = p.since?.pos ?? null;
  const sharing = await hs.rooms.usersSharingRooms(p.session.userId);
  const out: Record<string, any> = {};
  const add = (userId: string, field: string, value: unknown) => {
    (out[userId] ??= { profile_updates: {} }).profile_updates[field] = value ?? null;
  };
  // Users whose profile we must send in full: everyone on initial sync, newly shared users otherwise.
  const full = new Set<string>(since === null ? sharing : []);
  if (since !== null) {
    const myRooms = new Set(memberships.filter((m) => m.membership === "join").map((m) => m.room_id));
    const changes = await memberChanges();
    for (const c of changes) {
      if (c.stream > p.to || c.user_id === p.session.userId) continue;
      if (c.membership === "join" && myRooms.has(c.room_id)) {
        // Profile changes re-send the join; only an actual new join counts as newly shared.
        const ev = await hs.rooms.getEvent(c.event_id);
        if (ev?.pdu.unsigned?.prev_content?.membership !== "join") full.add(c.user_id);
      } else if (!sharing.has(c.user_id) && (myRooms.has(c.room_id) || memberships.some((m) => m.room_id === c.room_id)))
        out[c.user_id] = { profile_updates: null };
    }
    const rows = await hs.db.findMany("profile_fields", { where: [{ field: "stream", operator: "gt", value: since }] });
    for (const row of rows) {
      if (row.stream > p.to || !wanted.has(row.field) || !sharing.has(row.user_id) || full.has(row.user_id)) continue;
      add(row.user_id, row.field, row.value);
    }
  }
  for (const userId of full) {
    if (!sharing.has(userId) || !hs.isLocalUser(userId)) continue;
    const profile = (await fullProfile(hs, userId)) ?? {};
    for (const field of wanted) if (profile[field] !== undefined) add(userId, field, profile[field]);
  }
  return Object.keys(out).length ? out : null;
}
