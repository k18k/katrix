import { getState } from "#core/authrules.ts";
import { isObject } from "#core/json.ts";
import type { StoredEvent } from "#core/rooms.ts";
import type { Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import { v } from "#core/vpm.ts";
import { body, fail } from "#http/input.ts";
import { matchesFilter, type EventFilter } from "#api/filters.ts";
import { paginate, topoToken } from "#api/timeline.ts";
import { M } from "#core/m.ts";

const DEFAULT_KEYS = ["content.body", "content.name", "content.topic"];

function valueAt(obj: any, path: string): unknown {
  return path.split(".").reduce((o, k) => (isObject(o) ? o[k] : undefined), obj);
}

export function registerSearchRoutes(r: Router): void {
  const missingTerm = fail("M_BAD_JSON", "Missing search_categories.room_events.search_term");
  const searchBody = body({
    search_categories: v.looseObject(
      {
        room_events: v.looseObject(
          {
            search_term: v.string(missingTerm),
            keys: v.unknown().optional(),
            filter: v.unknown().optional(),
            order_by: v.unknown().optional(),
          },
          missingTerm,
        ),
      },
      missingTerm,
    ),
  });
  r.client(
    "POST",
    "/search",
    procedure({
      auth: "user",
      input: searchBody,
      handler: async (ctx) => {
        const s = ctx.session;
        const hs = ctx.hs;
        const criteria: Record<string, any> = ctx.input.search_categories.room_events;
        const terms: string[] = criteria.search_term.toLowerCase().split(/\s+/).filter(Boolean);
        const keys: string[] = Array.isArray(criteria.keys) && criteria.keys.length ? criteria.keys : DEFAULT_KEYS;
        const filter: EventFilter = isObject(criteria.filter) ? criteria.filter : {};
        const limit = Math.min(filter.limit ?? 10, 100);
        const orderBy = criteria.order_by === "recent" ? "recent" : "rank";
        const offset = Number.parseInt(ctx.query.get("next_batch") ?? "0", 10) || 0;

        let rooms = await hs.rooms.roomsForUser(s.userId);
        if (filter.rooms) rooms = rooms.filter((r) => filter.rooms!.includes(r));
        if (filter.not_rooms) rooms = rooms.filter((r) => !filter.not_rooms!.includes(r));

        const hits: { ev: StoredEvent; rank: number }[] = [];
        for (const roomId of rooms) {
          const rows = await hs.db.findMany("events", {
            where: [{ field: "room_id", value: roomId }],
            sortBy: { field: "stream", direction: "desc" },
          });
          const candidates: { ev: StoredEvent; rank: number }[] = [];
          for (const row of rows) {
            if (row.state_key !== null || !matchesFilter(filter, row.json)) continue;
            // Every search term must appear in one of the searched keys.
            let rank = 0;
            const words: string[] = [];
            for (const key of keys) {
              const v = valueAt(row.json, key);
              if (typeof v === "string") words.push(...v.toLowerCase().split(/[^\p{L}\p{N}]+/u));
            }
            if (terms.every((t) => words.includes(t))) for (const t of terms) rank += words.filter((w) => w === t).length;
            if (rank > 0) {
              candidates.push({ ev: hs.rooms.rowToStored(row), rank });
            }
          }
          const visible = new Set(
            (
              await hs.rooms.filterVisible(
                s.userId,
                roomId,
                candidates.map((c) => c.ev),
              )
            ).map((v) => v.pdu.event_id),
          );
          hits.push(...candidates.filter((c) => visible.has(c.ev.pdu.event_id)));
        }
        hits.sort((a, b) => (orderBy === "rank" && b.rank !== a.rank ? b.rank - a.rank : b.ev.stream - a.ev.stream));

        const page = hits.slice(offset, offset + limit);
        const viewer = { userId: s.userId, deviceId: s.deviceId };
        const ec = isObject(criteria.event_context) ? criteria.event_context : null;
        const results = [];
        for (const hit of page) {
          const result: Record<string, any> = { rank: hit.rank, result: hs.rooms.formatEvent(hit.ev, viewer) };
          if (ec) {
            const roomId = hit.ev.pdu.room_id;
            const here = { depth: hit.ev.pdu.depth, stream: hit.ev.stream };
            const before = await paginate(hs, s.userId, roomId, { from: here, to: null, dir: "b", limit: ec.before_limit ?? 5 });
            const after = await paginate(hs, s.userId, roomId, { from: here, to: null, dir: "f", limit: ec.after_limit ?? 5 });
            const context: Record<string, any> = {
              events_before: before.events.map((e) => hs.rooms.formatEvent(e, viewer)),
              events_after: after.events.map((e) => hs.rooms.formatEvent(e, viewer)),
              start: before.end ?? topoToken(before.events.at(-1) ?? hit.ev),
              end: topoToken(after.events.at(-1) ?? hit.ev),
            };
            if (ec.include_profile) {
              const state = await hs.rooms.currentState(roomId);
              const profile_info: Record<string, any> = {};
              for (const e of [...before.events, hit.ev, ...after.events]) {
                const m = getState(state, M.ROOM.MEMBER, e.pdu.sender)?.content;
                profile_info[e.pdu.sender] = { displayname: m?.displayname, avatar_url: m?.avatar_url };
              }
              context.profile_info = profile_info;
            }
            result.context = context;
          }
          results.push(result);
        }
        const out: Record<string, any> = { results, count: hits.length, highlights: terms };
        if (page.length === limit && offset + limit <= hits.length) out.next_batch = String(offset + limit);
        if (criteria.include_state) {
          out.state = {};
          for (const roomId of new Set(page.map((h) => h.ev.pdu.room_id))) {
            out.state[roomId] = [...(await hs.rooms.currentState(roomId)).values()].map((e) =>
              hs.rooms.formatEvent({ pdu: e, stream: 0, snapshot: 0, txnId: null, txnToken: null }),
            );
          }
        }
        if (criteria.groupings?.group_by?.some?.((g: any) => g?.key === "room_id")) {
          const groups: Record<string, any> = {};
          hits.forEach((h, i) => {
            const g = (groups[h.ev.pdu.room_id] ??= { results: [], order: i, next_batch: null });
            g.results.push(h.ev.pdu.event_id);
          });
          out.groups = { room_id: groups };
        }
        return { search_categories: { room_events: out } };
      },
    }),
  );
}
