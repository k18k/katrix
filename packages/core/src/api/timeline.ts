import { errors } from "#core/errors.ts";
import { getState } from "#core/authrules.ts";
import { toClientEvent, type PDU } from "#core/events.ts";
import { isObject } from "#core/json.ts";
import type { StoredEvent } from "#core/rooms.ts";
import type { Homeserver } from "#homeserver.ts";
import type { RequestContext, Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import { matchesFilter, parseRoomEventFilter, type EventFilter } from "#api/filters.ts";
import { M } from "#core/m.ts";
import { parseToken, requireRoom, viewerOf, visibleState } from "#api/rooms.ts";

// Room timelines: /messages (with backfill over federation), single events, /context, relations,
// threads and timestamp_to_event.

/** A gap event reached by backwards pagination (in the page, or anywhere older when the page ran out). */
async function findGapBefore(hs: Homeserver, roomId: string, events: StoredEvent[], end: string | null): Promise<StoredEvent | null> {
  if (!hs.federation.enabled) return null;
  const inPage = events.find((e) => e.gap);
  if (inPage) return inPage;
  if (end !== null) return null;
  const rows = await hs.db.findMany("events", {
    where: [
      { field: "room_id", value: roomId },
      { field: "gap", value: true },
    ],
    limit: 1,
  });
  return rows[0] ? hs.rooms.rowToStored(rows[0]) : null;
}

/** Backfill the history behind a gap event, then clear its gap flag. */
async function backfillGap(hs: Homeserver, roomId: string, gapEvent: StoredEvent): Promise<boolean> {
  const fetched = await hs.federation.backfill(roomId, [gapEvent.pdu.event_id!], 100);
  await hs.db.update("events", [{ field: "event_id", value: gapEvent.pdu.event_id }], { gap: false });
  hs.rooms.forgetEventCache(gapEvent.pdu.event_id!);
  return fetched > 0;
}

/** Backfill from other servers when our oldest event has unknown predecessors. Returns whether anything was fetched. */
async function backfillIfNeeded(hs: Homeserver, roomId: string): Promise<boolean> {
  if (!hs.federation.enabled) return false;
  const oldest = await hs.db.findMany("events", {
    where: [{ field: "room_id", value: roomId }],
    sortBy: { field: "stream", direction: "asc" },
    limit: 1,
  });
  const first = oldest[0];
  if (!first || first.type === M.ROOM.CREATE) return false;
  const prevs = ((first.json.prev_events ?? []) as unknown[]).map((p) => (Array.isArray(p) ? p[0] : p) as string);
  const known = await hs.rooms.getEvents(prevs);
  if (prevs.every((p) => known.has(p))) return false;
  return (await hs.federation.backfill(roomId, [first.event_id], 50)) > 0;
}

/** Fetch room events in stream order, applying visibility + filters, until `limit` are found. */
/**
 * A pagination position. Stream tokens (`s<n>`, from /sync) mean "everything persisted up
 * to n"; topological tokens (`t<depth>_<stream>`, from /messages) are a position in the
 * room's topological order (depth, then stream).
 */
export interface PageToken {
  depth: number | null;
  stream: number;
}

export function parsePageToken(raw: string | null): PageToken | null {
  if (raw === null || raw === "") return null;
  const topo = /^t(-?\d+)_(-?\d+)$/.exec(raw);
  if (topo) return { depth: Number(topo[1]), stream: Number(topo[2]) };
  const stream = /^s?(-?\d+)/.exec(raw);
  if (stream) return { depth: null, stream: Number(stream[1]) };
  throw errors.invalidParam("Invalid pagination token");
}

export const topoToken = (ev: { pdu: { depth: number }; stream: number }) => `t${ev.pdu.depth}_${ev.stream}`;

/** Topological comparison of (depth, stream) pairs. */
const cmp = (a: { depth: number; stream: number }, b: { depth: number; stream: number }) => a.depth - b.depth || a.stream - b.stream;

/**
 * Fetch room events in topological order (as /messages requires), applying history
 * visibility and filters, until `limit` events are found.
 */
export async function paginate(
  hs: Homeserver,
  userId: string | null,
  roomId: string,
  opts: { from: PageToken | null; to: PageToken | null; dir: "b" | "f"; limit: number; filter?: EventFilter },
): Promise<{ events: StoredEvent[]; end: string | null }> {
  const back = opts.dir === "b";
  const out: StoredEvent[] = [];
  // Position of the last examined event (exclusive bound for the next batch).
  let cursor: { depth: number; stream: number } | null =
    opts.from && opts.from.depth !== null ? { depth: opts.from.depth, stream: opts.from.stream } : null;
  const streamBound = opts.from && opts.from.depth === null ? opts.from.stream : null;
  const batch = Math.max(opts.limit * 2, 50);
  const beyond = (pos: { depth: number; stream: number }) => {
    if (!opts.to) return false;
    if (opts.to.depth === null) return back ? pos.stream <= opts.to.stream : pos.stream > opts.to.stream;
    const c = cmp(pos, { depth: opts.to.depth, stream: opts.to.stream });
    return back ? c <= 0 : c > 0;
  };
  for (;;) {
    const where: any[] = [{ field: "room_id", value: roomId }];
    if (cursor) where.push({ field: "depth", operator: back ? "lte" : "gte", value: cursor.depth });
    if (streamBound !== null) where.push({ field: "stream", operator: back ? "lte" : "gt", value: streamBound });
    let rows = await hs.db.findMany("events", { where, sortBy: { field: "depth", direction: back ? "desc" : "asc" }, limit: batch });
    const full = rows.length === batch;
    if (full) {
      // Rows of the boundary depth may be cut off by the limit: fetch that depth completely.
      const edge = rows[rows.length - 1].depth;
      rows = rows.filter((r) => r.depth !== edge);
      rows.push(...(await hs.db.findMany("events", { where: [...where, { field: "depth", value: edge }] })));
    }
    const stored = rows
      .map((r) => hs.rooms.rowToStored(r))
      .map((ev) => ({ ev, pos: { depth: ev.pdu.depth, stream: ev.stream } }))
      .filter(({ pos }) => !cursor || (back ? cmp(pos, cursor) < 0 : cmp(pos, cursor) > 0))
      .sort((a, b) => (back ? cmp(b.pos, a.pos) : cmp(a.pos, b.pos)));
    if (stored.length === 0) return { events: out, end: null };
    const visible = await hs.rooms.filterVisible(
      userId,
      roomId,
      stored.map((x) => x.ev),
    );
    const visibleById = new Map(visible.map((v) => [v.pdu.event_id, v]));
    for (const { ev: raw, pos } of stored) {
      if (beyond(pos)) return { events: out, end: null };
      cursor = pos;
      const ev = visibleById.get(raw.pdu.event_id);
      if (!ev || !matchesFilter(opts.filter, ev.pdu)) continue;
      out.push(ev);
      if (out.length >= opts.limit) return { events: out, end: `t${pos.depth}_${pos.stream}` };
    }
    if (!full) return { events: out, end: null };
  }
}

async function relations(ctx: RequestContext) {
  const s = await ctx.auth();
  const hs = ctx.hs;
  const roomId = ctx.params.roomId;
  await visibleState(hs, roomId, s.userId);
  const parent = await hs.rooms.getEvent(ctx.params.eventId);
  if (!parent || parent.pdu.room_id !== roomId) throw errors.notFound("Event not found");
  const dir = ctx.query.get("dir") === "f" ? "f" : "b";
  const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "50", 10) || 50, 1), 1000);
  const from = parseToken(ctx.query.get("from"));
  const rows = await hs.db.findMany("events", {
    where: [
      { field: "room_id", value: roomId },
      ...(from !== null ? [{ field: "stream", operator: dir === "b" ? "lte" : "gt", value: from } as const] : []),
    ],
    sortBy: { field: "stream", direction: dir === "b" ? "desc" : "asc" },
  });
  const matches: StoredEvent[] = [];
  let next: number | null = null;
  for (const row of rows) {
    const rel = (row.json as PDU).content?.[M.RELATES_TO];
    if (!isObject(rel) || rel.event_id !== ctx.params.eventId) continue;
    if (ctx.params.relType && rel.rel_type !== ctx.params.relType) continue;
    if (ctx.params.eventType && row.type !== ctx.params.eventType) continue;
    const stored = hs.rooms.rowToStored(row);
    if ((await hs.rooms.filterVisible(s.userId, roomId, [stored])).length === 0) continue;
    if (matches.length >= limit) {
      next = dir === "b" ? matches[matches.length - 1].stream - 1 : matches[matches.length - 1].stream;
      break;
    }
    matches.push(stored);
  }
  const out: Record<string, any> = { chunk: matches.map((e) => hs.rooms.formatEvent(e, { userId: s.userId, deviceId: s.deviceId })) };
  if (next !== null) out.next_batch = `s${next}`;
  return out;
}

/** `GET /rooms/{roomId}/threads`: thread roots, most recently active first. */
async function threads(ctx: RequestContext) {
  const s = await ctx.auth();
  const hs = ctx.hs;
  const roomId = ctx.params.roomId;
  await visibleState(hs, roomId, s.userId);
  const include = ctx.query.get("include") === "participated" ? "participated" : "all";
  const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "50", 10) || 50, 1), 1000);
  const from = parseToken(ctx.query.get("from"));
  const rows = await hs.db.findMany("events", {
    where: [{ field: "room_id", value: roomId }],
    sortBy: { field: "stream", direction: "desc" },
  });
  // Latest activity per thread root.
  const latest = new Map<string, { stream: number; latestId: string; count: number; participants: Set<string> }>();
  for (const row of rows) {
    const rel = (row.json as PDU).content?.[M.RELATES_TO];
    if (!isObject(rel) || rel.rel_type !== M.THREAD || typeof rel.event_id !== "string") continue;
    const entry = latest.get(rel.event_id) ?? { stream: row.stream, latestId: row.event_id, count: 0, participants: new Set<string>() };
    entry.participants.add(row.sender);
    entry.count++;
    latest.set(rel.event_id, entry);
  }
  const roots: { ev: StoredEvent; stream: number }[] = [];
  for (const [rootId, info] of latest) {
    const root = await hs.rooms.getEvent(rootId);
    if (!root || root.pdu.room_id !== roomId) continue;
    if (include === "participated" && root.pdu.sender !== s.userId && !info.participants.has(s.userId)) continue;
    if ((await hs.rooms.filterVisible(s.userId, roomId, [root])).length === 0) continue;
    roots.push({ ev: root, stream: info.stream });
  }
  roots.sort((a, b) => b.stream - a.stream);
  const page = roots.filter((r) => from === null || r.stream <= from);
  const chunk = page.slice(0, limit);
  const viewer = { userId: s.userId, deviceId: s.deviceId };
  const out: Record<string, any> = {
    chunk: await Promise.all(
      chunk.map(async (r) => {
        const ev = hs.rooms.formatEvent(r.ev, viewer);
        const info = latest.get(r.ev.pdu.event_id!)!;
        const latestEv = await hs.rooms.getEvent(info.latestId);
        ev.unsigned = {
          ...ev.unsigned,
          [M.RELATIONS]: {
            ...ev.unsigned?.[M.RELATIONS],
            [M.THREAD]: {
              latest_event: latestEv ? hs.rooms.formatEvent(latestEv, viewer) : undefined,
              count: info.count,
              current_user_participated: r.ev.pdu.sender === s.userId || info.participants.has(s.userId),
            },
          },
        };
        return ev;
      }),
    ),
  };
  if (page.length > limit) out.next_batch = `s${page[limit].stream}`;
  return out;
}

export function registerTimelineRoutes(r: Router): void {
  r.client(
    "GET",
    "/rooms/:roomId/messages",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const hs = ctx.hs;
        const roomId = ctx.params.roomId;
        await visibleState(hs, roomId, s.userId);
        const dir = ctx.query.get("dir") ?? "b";
        if (dir !== "b" && dir !== "f") throw errors.invalidParam("dir must be 'b' or 'f'");
        const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "10", 10) || 10, 1), 1000);
        const filter = parseRoomEventFilter(ctx);
        const fromRaw = ctx.query.get("from");
        const from: PageToken | null =
          parsePageToken(fromRaw) ?? (dir === "b" ? { depth: null, stream: await hs.streams.position() } : null);
        const to = parsePageToken(ctx.query.get("to"));
        let { events, end } = await paginate(hs, s.userId, roomId, { from, to, dir, limit: filter?.limit ?? limit, filter });
        // Reached a gap (e.g. history before we joined) or the start of our copy: ask other servers.
        for (let attempt = 0; attempt < 3 && dir === "b"; attempt++) {
          const gapEvent = await findGapBefore(hs, roomId, events, end);
          const fetched = gapEvent
            ? await backfillGap(hs, roomId, gapEvent)
            : end === null && events.length < (filter?.limit ?? limit) && (await backfillIfNeeded(hs, roomId));
          if (!fetched) break;
          ({ events, end } = await paginate(hs, s.userId, roomId, { from, to, dir, limit: filter?.limit ?? limit, filter }));
        }
        const out: Record<string, any> = {
          chunk: events.map((e) => hs.rooms.formatEvent(e, viewerOf(s))),
          start: fromRaw ?? (from ? (from.depth === null ? `s${from.stream}` : `t${from.depth}_${from.stream}`) : "t0_0"),
        };
        if (end !== null) out.end = end;
        else if (events.length) out.end = topoToken(events[events.length - 1]);
        if (filter?.lazy_load_members) {
          const current = await hs.rooms.currentState(roomId);
          const senders = new Set(events.map((e) => e.pdu.sender));
          out.state = [...senders]
            .map((u) => getState(current, M.ROOM.MEMBER, u))
            .filter(Boolean)
            .map((e) => toClientEvent(e!));
        }
        return out;
      },
    }),
  );

  r.client(
    "GET",
    "/rooms/:roomId/event/:eventId",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const hs = ctx.hs;
        await requireRoom(hs, ctx.params.roomId);
        const ev = await hs.rooms.getEvent(ctx.params.eventId);
        if (!ev || ev.pdu.room_id !== ctx.params.roomId) throw errors.notFound("Event not found");
        const visible = await hs.rooms.filterVisible(s.userId, ctx.params.roomId, [ev]);
        if (visible.length === 0) throw errors.notFound("Event not found");
        return hs.rooms.formatEvent(ev, viewerOf(s)) as unknown as Record<string, unknown>;
      },
    }),
  );

  r.client(
    "GET",
    "/rooms/:roomId/context/:eventId",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const hs = ctx.hs;
        const roomId = ctx.params.roomId;
        await requireRoom(hs, roomId);
        const ev = await hs.rooms.getEvent(ctx.params.eventId);
        if (!ev || ev.pdu.room_id !== roomId || (await hs.rooms.filterVisible(s.userId, roomId, [ev])).length === 0) {
          throw errors.notFound("Event not found");
        }
        const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "10", 10) || 10, 0), 100);
        const filter = parseRoomEventFilter(ctx);
        const here = { depth: ev.pdu.depth, stream: ev.stream };
        const before = await paginate(hs, s.userId, roomId, {
          from: here,
          to: null,
          dir: "b",
          limit: Math.floor(limit / 2) || (limit ? 1 : 0),
          filter,
        });
        const after = await paginate(hs, s.userId, roomId, { from: here, to: null, dir: "f", limit: Math.ceil(limit / 2), filter });
        const beforeEvents = limit ? before.events : [];
        const afterEvents = limit ? after.events : [];
        const state = await hs.rooms.stateAtSnapshot(ev.snapshot);
        return {
          event: hs.rooms.formatEvent(ev, viewerOf(s)),
          events_before: beforeEvents.map((e) => hs.rooms.formatEvent(e, viewerOf(s))),
          events_after: afterEvents.map((e) => hs.rooms.formatEvent(e, viewerOf(s))),
          start: topoToken(beforeEvents.length ? beforeEvents[beforeEvents.length - 1] : ev),
          end: topoToken(afterEvents.length ? afterEvents[afterEvents.length - 1] : ev),
          state: [...state.values()].map((e) => toClientEvent(e)),
        };
      },
    }),
  );

  const relVersions = ["v1", "v3"];
  r.client("GET", "/rooms/:roomId/relations/:eventId", procedure({ handler: relations }), relVersions);
  r.client("GET", "/rooms/:roomId/relations/:eventId/:relType", procedure({ handler: relations }), relVersions);
  r.client("GET", "/rooms/:roomId/relations/:eventId/:relType/:eventType", procedure({ handler: relations }), relVersions);
  r.client("GET", "/rooms/:roomId/threads", procedure({ handler: threads }), ["v1"]);

  r.client(
    "GET",
    "/rooms/:roomId/timestamp_to_event",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const hs = ctx.hs;
        const roomId = ctx.params.roomId;
        await visibleState(hs, roomId, s.userId);
        const ts = Number(ctx.query.get("ts"));
        const dir = ctx.query.get("dir");
        if (!Number.isFinite(ts) || (dir !== "f" && dir !== "b")) throw errors.invalidParam("Invalid ts or dir");
        let local: { event_id: string; origin_server_ts: number } | null = null;
        const rows = await hs.db.findMany("events", { where: [{ field: "room_id", value: roomId }] });
        // Equal timestamps: the topologically nearest event in the search direction wins.
        rows.sort((a, b) =>
          dir === "f"
            ? a.json.origin_server_ts - b.json.origin_server_ts || a.depth - b.depth || a.stream - b.stream
            : b.json.origin_server_ts - a.json.origin_server_ts || b.depth - a.depth || b.stream - a.stream,
        );
        for (const row of rows) {
          const t = row.json.origin_server_ts;
          if (!(dir === "f" ? t >= ts : t <= ts)) continue;
          const visible = await hs.rooms.filterVisible(s.userId, roomId, [hs.rooms.rowToStored(row)]);
          if (visible.length) {
            local = { event_id: row.event_id, origin_server_ts: t };
            break;
          }
        }
        // A closer event may exist on another server (e.g. history we never backfilled).
        if (hs.federation.enabled) {
          for (const server of hs.federation.serversInRoom(await hs.rooms.currentState(roomId))) {
            try {
              const remote = await hs.federation.client.request(
                server,
                "GET",
                `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(roomId)}`,
                { query: { ts: String(ts), dir }, timeoutMs: 10_000 },
              );
              if (typeof remote.event_id !== "string" || typeof remote.origin_server_ts !== "number") continue;
              const closer =
                !local ||
                (dir === "f" ? remote.origin_server_ts < local.origin_server_ts : remote.origin_server_ts > local.origin_server_ts);
              if (closer) {
                // Make sure we have the event locally so clients can paginate from it.
                if (!(await hs.rooms.getEvent(remote.event_id))) await hs.federation.backfill(roomId, [remote.event_id], 1).catch(() => 0);
                local = { event_id: remote.event_id, origin_server_ts: remote.origin_server_ts };
              }
              break;
            } catch {
              /* try the next server */
            }
          }
        }
        if (!local) throw errors.notFound("No event found");
        return local;
      },
    }),
    ["v1", "v3"],
  );
}
