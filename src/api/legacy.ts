import { errors } from "#core/errors.ts";
import { toClientEvent } from "#core/events.ts";
import { isValidRoomId } from "#core/ids.ts";
import type { Session } from "#core/auth.ts";
import type { StoredEvent } from "#core/rooms.ts";
import type { Homeserver } from "#homeserver.ts";
import type { Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import { paginate, visibleState } from "#api/rooms.ts";

// Endpoints from before /sync (deprecated since r0 but still in the spec), and room previews
// ("peeking") through /rooms/{roomId}/initialSync and /events?room_id=.

const viewerOf = (s: Session) => ({ userId: s.userId, deviceId: s.deviceId });

const parseStreamToken = (raw: string | null, fallback: number): number => {
  if (raw === null) return fallback;
  const m = /^s(\d+)/.exec(raw);
  if (!m) throw errors.invalidParam("Invalid from token");
  return Number(m[1]);
};

async function roomAccountData(hs: Homeserver, userId: string, roomId: string): Promise<Record<string, unknown>[]> {
  const rows = await hs.db.findMany("account_data", {
    where: [
      { field: "user_id", value: userId },
      { field: "room_id", value: roomId },
    ],
  });
  return rows.map((r) => ({ type: r.type, content: r.content }));
}

/** Current state and latest messages of a room the user may see (also for peeking). */
async function roomInfo(hs: Homeserver, s: Session, roomId: string, limit: number): Promise<Record<string, unknown>> {
  const state = await visibleState(hs, roomId, s.userId);
  // Peekers who never were in the room have no membership.
  const row = await hs.db.findOne("memberships", [
    { field: "room_id", value: roomId },
    { field: "user_id", value: s.userId },
  ]);
  const membership: string | undefined = row?.membership ?? undefined;
  const position = await hs.streams.position();
  const { events, end } = await paginate(hs, s.userId, roomId, { from: { depth: null, stream: position }, to: null, dir: "b", limit });
  const chunk = events.reverse();
  const room = await hs.db.findOne("rooms", [{ field: "room_id", value: roomId }]);
  return {
    room_id: roomId,
    ...(membership ? { membership } : {}),
    messages: {
      chunk: chunk.map((e) => hs.rooms.formatEvent(e, viewerOf(s))),
      start: end ?? (chunk.length ? `t${chunk[0].pdu.depth}_${chunk[0].stream}` : `s${position}`),
      end: `s${position}`,
    },
    state: [...state.values()].map((e) => toClientEvent(e)),
    visibility: room?.is_public ? "public" : "private",
    account_data: membership ? await roomAccountData(hs, s.userId, roomId) : [],
    presence: [],
    receipts: [],
  };
}

/** Events after `from` in the given rooms, oldest first. */
async function eventsSince(hs: Homeserver, s: Session, roomIds: string[], from: number, limit: number): Promise<StoredEvent[]> {
  const all: StoredEvent[] = [];
  for (const roomId of roomIds) {
    const { events } = await paginate(hs, s.userId, roomId, { from: { depth: null, stream: from }, to: null, dir: "f", limit });
    all.push(...events);
  }
  return all.sort((a, b) => a.stream - b.stream).slice(0, limit);
}

export function registerLegacyRoutes(r: Router): void {
  r.client(
    "GET",
    "/initialSync",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const hs = ctx.hs;
        const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "10", 10) || 10, 0), 100);
        const memberships = ["join", "invite", ...(ctx.query.get("archived") === "true" ? ["leave", "ban"] : [])];
        const rooms: Record<string, unknown>[] = [];
        for (const membership of memberships) {
          for (const roomId of await hs.rooms.roomsForUser(s.userId, membership)) {
            if (membership === "invite") {
              const invite = await hs.rooms.membershipEvent(roomId, s.userId);
              rooms.push({ room_id: roomId, membership, ...(invite ? { invite: hs.rooms.formatEvent(invite, viewerOf(s)) } : {}) });
              continue;
            }
            try {
              rooms.push(await roomInfo(hs, s, roomId, limit));
            } catch {
              /* not visible (e.g. forgotten) */
            }
          }
        }
        const account = await hs.db.findMany("account_data", {
          where: [
            { field: "user_id", value: s.userId },
            { field: "room_id", value: "" },
          ],
        });
        return {
          end: `s${await hs.streams.position()}`,
          rooms,
          presence: [],
          account_data: account.map((a) => ({ type: a.type, content: a.content })),
        };
      },
    }),
  );

  r.client(
    "GET",
    "/rooms/:roomId/initialSync",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        if (!isValidRoomId(ctx.params.roomId)) throw errors.invalidParam("Invalid room ID");
        const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "10", 10) || 10, 0), 100);
        return roomInfo(ctx.hs, s, ctx.params.roomId, limit);
      },
    }),
  );

  r.client(
    "GET",
    "/events/:eventId",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const ev = await ctx.hs.rooms.getEvent(ctx.params.eventId);
        if (!ev || !(await ctx.hs.rooms.filterVisible(s.userId, ev.pdu.room_id, [ev])).length) throw errors.notFound("Event not found");
        return ctx.hs.rooms.formatEvent(ev, viewerOf(s), { includeRoomId: true }) as unknown as Record<string, unknown>;
      },
    }),
  );

  // New events in the user's rooms, or in one room the user may peek into (`room_id`).
  r.client(
    "GET",
    "/events",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const hs = ctx.hs;
        const now = await hs.streams.position();
        const from = parseStreamToken(ctx.query.get("from"), now);
        const timeout = Math.min(Math.max(Number(ctx.query.get("timeout") ?? 30_000) || 0, 0), hs.config.maxSyncTimeoutMs);
        const peekRoom = ctx.query.get("room_id");
        let roomIds: string[];
        if (peekRoom !== null) {
          if (!isValidRoomId(peekRoom)) throw errors.invalidParam("Invalid room ID");
          const { joined, worldReadable } = await hs.rooms.canPeek(peekRoom, s.userId);
          if (!joined && !worldReadable) throw errors.forbidden("You cannot peek into this room");
          roomIds = [peekRoom];
        } else {
          roomIds = await hs.rooms.roomsForUser(s.userId);
        }
        const deadline = Date.now() + timeout;
        for (;;) {
          const events = await eventsSince(hs, s, roomIds, from, 100);
          const remaining = deadline - Date.now();
          if (events.length || remaining <= 0 || ctx.request.signal.aborted) {
            const end = events.length ? events[events.length - 1].stream : Math.max(from, await hs.streams.position());
            return {
              start: `s${from}`,
              end: `s${end}`,
              chunk: events.map((e) => hs.rooms.formatEvent(e, viewerOf(s), { includeRoomId: true })),
            };
          }
          // Peekers are not woken for rooms they are not in, so also re-check periodically.
          await Promise.race([
            hs.notifier.wait(s.userId, remaining, ctx.request.signal),
            new Promise((resolve) => setTimeout(resolve, Math.min(remaining, peekRoom !== null ? 1000 : remaining)).unref?.()),
          ]);
        }
      },
    }),
  );
}
