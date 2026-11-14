import { isObject, isStrings, M, UNSTABLE } from "@katrix/shared";
import { globMatch as matchGlob } from "@katrix/shared";
import { errors } from "#core/errors.ts";
import type { PDU } from "#core/events.ts";
import type { RequestContext } from "#http/router.ts";

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

// Security (https://github.com/k18k/katrix/issues/2): filter patterns come from clients. Compiled to regexes they allowed
// catastrophic backtracking that hung the server (ReDoS); matched in linear time (core/glob.ts).
// Only `*` is a wildcard here.
function globMatch(pattern: string, value: string) {
  return matchGlob(pattern, value, { questionMark: false });
}

export function matchesFilter(filter: EventFilter | undefined, ev: { type: string; sender?: string; room_id?: string; content?: unknown }) {
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
    const relation = isObject(ev.content) ? ev.content[M.RELATES_TO] : undefined;
    const relType = isObject(relation) ? relation.rel_type : undefined;
    if (relTypes && (typeof relType !== "string" || !relTypes.includes(relType))) return false;
    if (notRelTypes && typeof relType === "string" && notRelTypes.includes(relType)) return false;
  }
  if (filter.contains_url !== undefined) {
    const has = isObject(ev.content) && typeof ev.content.url === "string";
    if (has !== filter.contains_url) return false;
  }
  return true;
}

export function roomAllowed(filter: SyncFilter, roomId: string) {
  const r = filter.room;
  if (!r) return true;
  if (r.not_rooms?.includes(roomId)) return false;
  if (r.rooms && !r.rooms.includes(roomId)) return false;
  return true;
}

const LIST_FIELDS = [
  "types",
  "not_types",
  "senders",
  "not_senders",
  "rooms",
  "not_rooms",
  "rel_types",
  "not_rel_types",
  UNSTABLE.ORG.MATRIX.MSC3874.REL_TYPES,
  UNSTABLE.ORG.MATRIX.MSC3874.NOT_REL_TYPES,
] as const satisfies readonly (keyof EventFilter)[];
const FLAG_FIELDS = [
  "contains_url",
  "lazy_load_members",
  "include_redundant_members",
  "unread_thread_notifications",
] as const satisfies readonly (keyof EventFilter)[];

/** Throws M_BAD_JSON unless `f` is an event filter (or absent). */
export function assertEventFilter(f: unknown, name: string): asserts f is EventFilter | undefined {
  if (f === undefined) return;
  if (!isObject(f)) throw errors.badJson(`${name} must be an object`);
  for (const key of LIST_FIELDS) {
    if (f[key] !== undefined && !isStrings(f[key])) {
      throw errors.badJson(`${name}.${key} must be a list of strings`);
    }
  }
  // https://github.com/k18k/katrix/issues/128: the relation lists and flags were not checked, and the filter was cast to
  // EventFilter; every field of the type is checked here, so the assertion holds.
  for (const key of FLAG_FIELDS) {
    if (f[key] !== undefined && typeof f[key] !== "boolean") throw errors.badJson(`${name}.${key} must be a boolean`);
  }
  // https://github.com/k18k/katrix/issues/128: the lists were read as any; they are checked string lists here.
  const allStartWith = (key: string, prefix: string) => {
    const list = f[key];
    return !isStrings(list) || list.every((x) => x.startsWith(prefix));
  };
  if (!allStartWith("rooms", "!") || !allStartWith("not_rooms", "!")) {
    throw errors.badJson(`${name}: rooms must be room IDs`);
  }
  if (!allStartWith("senders", "@") || !allStartWith("not_senders", "@")) {
    throw errors.badJson(`${name}: senders must be user IDs`);
  }
  if (f.limit !== undefined && (typeof f.limit !== "number" || !Number.isInteger(f.limit) || f.limit < 0))
    throw errors.badJson(`${name}.limit must be a non-negative integer`);
}

export function validateSyncFilter(f: unknown) {
  if (!isObject(f)) throw errors.badJson("Filter must be an object");
  for (const k of ["presence", "account_data"]) assertEventFilter(f[k], k);
  if (f.room !== undefined) {
    if (!isObject(f.room)) throw errors.badJson("room must be an object");
    for (const k of ["timeline", "state", "ephemeral", "account_data"]) assertEventFilter(f.room[k], `room.${k}`);
    assertEventFilter({ rooms: f.room.rooms, not_rooms: f.room.not_rooms }, "room");
  }
  if (f.event_format !== undefined && f.event_format !== "client" && f.event_format !== "federation")
    throw errors.badJson("Invalid event_format");
  return f as SyncFilter;
}

/** Parse the `filter` query param of /messages and /context (a JSON RoomEventFilter). */
export function parseRoomEventFilter(ctx: RequestContext) {
  const raw = ctx.query.get("filter");
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw errors.badJson("Invalid filter JSON");
  }
  assertEventFilter(parsed, "filter");
  return parsed;
}

/** Member events needed to render `events` when lazy-loading members. */
export function lazyMemberKeys(events: PDU[]) {
  return new Set(events.map((e) => e.sender));
}
