import { globMatch as matchGlob } from "#core/glob.ts";
import { errors } from "#core/errors.ts";
import { isObject } from "#core/json.ts";
import type { PDU } from "#core/events.ts";
import type { RequestContext } from "#http/router.ts";
import { M, UNSTABLE } from "#core/m.ts";

export interface EventFilter {
  limit?: number;
  types?: string[];
  not_types?: string[];
  senders?: string[];
  not_senders?: string[];
  rooms?: string[];
  not_rooms?: string[];
  contains_url?: boolean;
  lazy_load_members?: boolean;
  include_redundant_members?: boolean;
  unread_thread_notifications?: boolean;
  rel_types?: string[];
  not_rel_types?: string[];
  [UNSTABLE.ORG.MATRIX.MSC3874.REL_TYPES]?: string[];
  [UNSTABLE.ORG.MATRIX.MSC3874.NOT_REL_TYPES]?: string[];
}

export interface SyncFilter {
  event_fields?: string[];
  event_format?: "client" | "federation";
  /** MSC4429: profile fields whose changes are delivered in sync. */
  profile_fields?: { ids?: string[] };
  [UNSTABLE.ORG.MATRIX.MSC4429.PROFILE_FIELDS]?: { ids?: string[] };
  presence?: EventFilter;
  account_data?: EventFilter;
  room?: {
    rooms?: string[];
    not_rooms?: string[];
    include_leave?: boolean;
    timeline?: EventFilter;
    state?: EventFilter;
    ephemeral?: EventFilter;
    account_data?: EventFilter;
  };
}

// Security (https://github.com/k18k/matrix-nodejs-homeserver/issues/2): filter patterns come from clients. Compiled to regexes they allowed
// catastrophic backtracking that hung the server (ReDoS); matched in linear time (core/glob.ts).
// Only `*` is a wildcard here.
function globMatch(pattern: string, value: string): boolean {
  return matchGlob(pattern, value, { questionMark: false });
}

export function matchesFilter(
  filter: EventFilter | undefined,
  ev: { type: string; sender?: string; room_id?: string; content?: any },
): boolean {
  if (!filter) return true;
  if (filter.not_types?.some((t) => globMatch(t, ev.type))) return false;
  if (filter.types && !filter.types.some((t) => globMatch(t, ev.type))) return false;
  if (ev.sender !== undefined) {
    if (filter.not_senders?.includes(ev.sender)) return false;
    if (filter.senders && !filter.senders.includes(ev.sender)) return false;
  }
  if (ev.room_id !== undefined) {
    if (filter.not_rooms?.includes(ev.room_id)) return false;
    if (filter.rooms && !filter.rooms.includes(ev.room_id)) return false;
  }
  const relTypes = filter.rel_types ?? filter[UNSTABLE.ORG.MATRIX.MSC3874.REL_TYPES];
  const notRelTypes = filter.not_rel_types ?? filter[UNSTABLE.ORG.MATRIX.MSC3874.NOT_REL_TYPES];
  if (relTypes || notRelTypes) {
    const relType = ev.content?.[M.RELATES_TO]?.rel_type;
    if (relTypes && !relTypes.includes(relType)) return false;
    if (notRelTypes && typeof relType === "string" && notRelTypes.includes(relType)) return false;
  }
  if (filter.contains_url !== undefined) {
    const has = typeof ev.content?.url === "string";
    if (has !== filter.contains_url) return false;
  }
  return true;
}

export function roomAllowed(filter: SyncFilter, roomId: string): boolean {
  const r = filter.room;
  if (!r) return true;
  if (r.not_rooms?.includes(roomId)) return false;
  if (r.rooms && !r.rooms.includes(roomId)) return false;
  return true;
}

function validateEventFilter(f: unknown, name: string): void {
  if (f === undefined) return;
  if (!isObject(f)) throw errors.badJson(`${name} must be an object`);
  for (const key of ["types", "not_types", "senders", "not_senders", "rooms", "not_rooms"]) {
    if (f[key] !== undefined && (!Array.isArray(f[key]) || !f[key].every((x: unknown) => typeof x === "string"))) {
      throw errors.badJson(`${name}.${key} must be a list of strings`);
    }
  }
  if (f.rooms?.some((r: string) => !r.startsWith("!")) || f.not_rooms?.some((r: string) => !r.startsWith("!"))) {
    throw errors.badJson(`${name}: rooms must be room IDs`);
  }
  if (f.senders?.some((u: string) => !u.startsWith("@")) || f.not_senders?.some((u: string) => !u.startsWith("@"))) {
    throw errors.badJson(`${name}: senders must be user IDs`);
  }
  if (f.limit !== undefined && (!Number.isInteger(f.limit) || f.limit < 0))
    throw errors.badJson(`${name}.limit must be a non-negative integer`);
}

export function validateSyncFilter(f: unknown): SyncFilter {
  if (!isObject(f)) throw errors.badJson("Filter must be an object");
  for (const k of ["presence", "account_data"]) validateEventFilter(f[k], k);
  if (f.room !== undefined) {
    if (!isObject(f.room)) throw errors.badJson("room must be an object");
    for (const k of ["timeline", "state", "ephemeral", "account_data"]) validateEventFilter(f.room[k], `room.${k}`);
    validateEventFilter({ rooms: f.room.rooms, not_rooms: f.room.not_rooms }, "room");
  }
  if (f.event_format !== undefined && !["client", "federation"].includes(f.event_format)) throw errors.badJson("Invalid event_format");
  return f as SyncFilter;
}

/** Parse the `filter` query param of /messages and /context (a JSON RoomEventFilter). */
export function parseRoomEventFilter(ctx: RequestContext): EventFilter | undefined {
  const raw = ctx.query.get("filter");
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw errors.badJson("Invalid filter JSON");
  }
  validateEventFilter(parsed, "filter");
  return parsed as EventFilter;
}

/** Member events needed to render `events` when lazy-loading members. */
export function lazyMemberKeys(events: PDU[]): Set<string> {
  return new Set(events.map((e) => e.sender));
}
