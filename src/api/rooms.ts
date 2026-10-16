import { MatrixError, errors } from "#core/errors.ts";
import { getState, membershipOf, ownerOfStateKey, powerLevels, roomCreators, userLevel, type StateMap } from "#core/authrules.ts";
import { validatePowerLevelContent } from "#core/rooms.ts";
import { SUPPORTED_ROOM_VERSIONS, roomVersionFeatures, splitStateKey, toClientEvent, type PDU } from "#core/events.ts";
import { isValidAlias, isValidRoomId, isValidUserId, parseId } from "#core/ids.ts";
import { isObject } from "#core/json.ts";
import type { StoredEvent } from "#core/rooms.ts";
import { assertNotSuspended, type Session } from "#core/auth.ts";
import type { Homeserver } from "#homeserver.ts";
import type { RequestContext, Router } from "#http/router.ts";
import { z } from "zod";
import { body, fail, lenient } from "#http/input.ts";
import { matchesFilter, parseRoomEventFilter, type EventFilter } from "#api/filters.ts";

export const parseToken = (token: string | null): number | null => {
  if (token === null || token === "") return null;
  const m = /^[st]?(\d+)/.exec(token);
  if (!m) throw errors.invalidParam("Invalid pagination token");
  return Number(m[1]);
};

const viewerOf = (s: Session) => ({ userId: s.userId, deviceId: s.deviceId });

async function requireRoom(hs: Homeserver, roomId: string): Promise<string> {
  if (!isValidRoomId(roomId)) throw errors.invalidParam("Invalid room ID");
  const version = await hs.rooms.roomVersion(roomId);
  if (!version) throw errors.forbidden("Room not found or you are not a member");
  return version;
}

/**
 * State visible to the user: current state when joined (or world readable),
 * otherwise the state at the moment they left.
 */
export async function visibleState(hs: Homeserver, roomId: string, userId: string): Promise<StateMap> {
  await requireRoom(hs, roomId);
  const { joined, worldReadable, membership } = await hs.rooms.canPeek(roomId, userId);
  if (joined || worldReadable) return hs.rooms.currentState(roomId);
  const row = await hs.db.findOne("memberships", [
    { field: "room_id", value: roomId },
    { field: "user_id", value: userId },
  ]);
  if (row?.forgotten) throw errors.forbidden("You have forgotten this room");
  if (membership === "leave" || membership === "ban") {
    const ev = await hs.rooms.membershipEvent(roomId, userId);
    if (ev && ev.pdu.sender !== undefined) {
      const previouslyJoined = ev.pdu.unsigned?.prev_content?.membership === "join" || membership === "ban";
      if (previouslyJoined) return hs.rooms.stateAtSnapshot(ev.snapshot);
    }
  }
  throw errors.forbidden("You are not a member of this room");
}

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
  if (!first || first.type === "m.room.create") return false;
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

/**
 * Invite by email address or phone number (spec "Third-party invites"): invite the Matrix user the
 * identity server knows for it, or store the invite there and emit an m.room.third_party_invite.
 */
async function inviteByThreepid(ctx: RequestContext, s: Session, body: Record<string, any>): Promise<Record<string, never>> {
  const hs = ctx.hs;
  const roomId = ctx.params.roomId;
  for (const k of ["id_server", "id_access_token", "medium", "address"]) {
    if (typeof body[k] !== "string") throw errors.missingParam(`Missing ${k}`);
  }
  await requireRoom(hs, roomId);
  await hs.rooms.requireJoined(roomId, s.userId);
  const mxid = await hs.identityServers.lookup(body.id_server, body.id_access_token, body.medium, body.address);
  if (mxid) {
    if ((await hs.rooms.membership(roomId, mxid)) === "ban") throw errors.forbidden("User is banned");
    await hs.rooms.invite(roomId, s.userId, mxid);
    return {};
  }
  const state = await hs.rooms.currentState(roomId);
  const profile = await hs.profile(s.userId);
  const create = getState(state, "m.room.create", "");
  const invite: Record<string, unknown> = {
    medium: body.medium,
    address: body.address,
    room_id: roomId,
    sender: s.userId,
    room_alias: getState(state, "m.room.canonical_alias", "")?.content?.alias,
    room_avatar_url: getState(state, "m.room.avatar", "")?.content?.url,
    room_join_rules: getState(state, "m.room.join_rules", "")?.content?.join_rule,
    room_name: getState(state, "m.room.name", "")?.content?.name,
    room_type: create?.content?.type,
    sender_display_name: profile.displayname,
    sender_avatar_url: profile.avatar_url,
  };
  for (const k of Object.keys(invite)) if (invite[k] === undefined || invite[k] === null) delete invite[k];
  const stored = await hs.identityServers.storeInvite(body.id_server, body.id_access_token, invite);
  const [first] = stored.public_keys;
  await hs.rooms.sendEvent(roomId, s.userId, {
    type: "m.room.third_party_invite",
    state_key: stored.token,
    content: {
      display_name: stored.display_name,
      key_validity_url: first?.key_validity_url,
      public_key: first?.public_key,
      public_keys: stored.public_keys,
    },
  });
  return {};
}

async function ownEvent(hs: Homeserver, userId: string, eventId: unknown): Promise<boolean> {
  return typeof eventId === "string" && (await hs.rooms.getPdu(eventId))?.sender === userId;
}

const membershipBody = body({ user_id: lenient(z.string()), reason: lenient(z.string()) });

async function sendMembership(
  ctx: RequestContext<z.output<typeof membershipBody>>,
  membership: "leave" | "ban" | "unban" | "kick",
): Promise<Record<string, never>> {
  const s = await ctx.auth();
  const roomId = ctx.params.roomId;
  // Leaving (and rejecting invites) stays possible while suspended; moderating others does not.
  if (membership !== "leave") await assertNotSuspended(ctx.hs, s, roomId);
  const body = ctx.input;
  const hs = ctx.hs;
  const reason = body.reason;
  if (membership === "leave") {
    // For rooms this server is not in (remote invites/knocks), the membership row is authoritative.
    const row = await hs.db.findOne("memberships", [
      { field: "room_id", value: roomId },
      { field: "user_id", value: s.userId },
    ]);
    if (!(await hs.rooms.exists(roomId)) && !row) throw errors.notFound("Room not found");
    const current = (await hs.rooms.serverIsJoined(roomId)) ? await hs.rooms.membership(roomId, s.userId) : (row?.membership ?? "leave");
    if (current === "leave") return {};
    if (current === "ban") throw errors.forbidden("You are banned from this room");
    if (current === "invite" && (await hs.admin.isNoticeRoom(roomId))) {
      throw new MatrixError(403, "M_CANNOT_LEAVE_SERVER_NOTICE_ROOM", "Server notice invites cannot be rejected");
    }
    await hs.rooms.setMembership(roomId, s.userId, s.userId, "leave", reason);
    return {};
  }
  if (!body.user_id || !isValidUserId(body.user_id)) throw errors.invalidParam("Invalid user_id");
  const target = body.user_id;
  await requireRoom(hs, roomId);
  if (membership === "unban") {
    if ((await hs.rooms.membership(roomId, target)) !== "ban") throw errors.forbidden("User is not banned");
    await hs.rooms.setMembership(roomId, s.userId, target, "leave", reason);
  } else if (membership === "kick") {
    const current = await hs.rooms.membership(roomId, target);
    if (current === "leave" || current === "ban") throw errors.forbidden("User is not in the room");
    await hs.rooms.setMembership(roomId, s.userId, target, "leave", reason);
  } else {
    await hs.rooms.setMembership(roomId, s.userId, target, "ban", reason);
  }
  await hs.audit.record({
    action: membership === "kick" ? "member_kick" : membership === "ban" ? "member_ban" : "member_unban",
    actor: s.userId,
    target: body.user_id,
    ip: ctx.ip,
    details: { room_id: roomId, reason },
  });
  return {};
}

async function validateStateEvent(
  hs: Homeserver,
  roomId: string,
  type: string,
  content: Record<string, any>,
  stateKeyValue = "",
): Promise<void> {
  if (type === "m.room.create") throw errors.badJson("The create event cannot be sent");
  if (
    stateKeyValue.startsWith("@") &&
    roomVersionFeatures((await hs.rooms.roomVersion(roomId))!).ownedState &&
    !ownerOfStateKey(stateKeyValue)
  ) {
    throw errors.badJson("Malformed user-owned state key");
  }
  if (type === "m.room.power_levels") {
    const version = (await hs.rooms.roomVersion(roomId))!;
    validatePowerLevelContent(content, roomCreators(await hs.rooms.currentState(roomId), version));
  }
  if (type === "m.room.canonical_alias") {
    const aliases = [content.alias, ...(Array.isArray(content.alt_aliases) ? content.alt_aliases : [])].filter(
      (a) => a !== undefined && a !== null,
    );
    if (content.alt_aliases !== undefined && !Array.isArray(content.alt_aliases))
      throw new MatrixError(400, "M_INVALID_PARAM", "alt_aliases must be a list");
    for (const alias of aliases) {
      if (!isValidAlias(alias)) throw new MatrixError(400, "M_INVALID_PARAM", "Invalid alias");
      const row = await hs.db.findOne("room_aliases", [{ field: "alias", value: alias }]);
      if (!row || row.room_id !== roomId) throw new MatrixError(400, "M_BAD_ALIAS", `Alias ${alias} does not point to this room`);
    }
  }
}

async function publicRoomChunk(hs: Homeserver, roomId: string): Promise<Record<string, any>> {
  const state = await hs.rooms.currentState(roomId);
  const get = (t: string) => getState(state, t)?.content;
  const chunk: Record<string, any> = {
    room_id: roomId,
    num_joined_members: (await hs.rooms.joinedMembers(roomId)).length,
    world_readable: get("m.room.history_visibility")?.history_visibility === "world_readable",
    guest_can_join: get("m.room.guest_access")?.guest_access === "can_join",
    join_rule: get("m.room.join_rules")?.join_rule ?? "invite",
  };
  if (typeof get("m.room.name")?.name === "string") chunk.name = get("m.room.name")!.name;
  if (typeof get("m.room.topic")?.topic === "string") chunk.topic = get("m.room.topic")!.topic;
  if (typeof get("m.room.canonical_alias")?.alias === "string") chunk.canonical_alias = get("m.room.canonical_alias")!.alias;
  if (typeof get("m.room.avatar")?.url === "string") chunk.avatar_url = get("m.room.avatar")!.url;
  const roomType = get("m.room.create")?.type;
  if (typeof roomType === "string") chunk.room_type = roomType;
  return chunk;
}

async function publicRooms(ctx: RequestContext, body: Record<string, any>) {
  const hs = ctx.hs;
  const limit = Number(body.limit ?? ctx.query.get("limit") ?? 0) || undefined;
  const since = body.since ?? ctx.query.get("since");
  const offset = since ? Number.parseInt(String(since).replace(/^o/, ""), 10) || 0 : 0;
  const term =
    isObject(body.filter) && typeof body.filter.generic_search_term === "string" ? body.filter.generic_search_term.toLowerCase() : null;
  const roomTypes = isObject(body.filter) && Array.isArray(body.filter.room_types) ? body.filter.room_types : null;
  const rooms = await hs.db.findMany("rooms", {
    where: [{ field: "is_public", value: true }],
    sortBy: { field: "created_ts", direction: "asc" },
  });
  let chunks = await Promise.all(rooms.map((r) => publicRoomChunk(hs, r.room_id)));
  if (term)
    chunks = chunks.filter((c) =>
      [c.name, c.topic, c.canonical_alias].some((v) => typeof v === "string" && v.toLowerCase().includes(term)),
    );
  if (roomTypes) chunks = chunks.filter((c) => roomTypes.includes(c.room_type ?? null));
  chunks.sort((a, b) => b.num_joined_members - a.num_joined_members);
  const page = limit ? chunks.slice(offset, offset + limit) : chunks.slice(offset);
  const out: Record<string, any> = { chunk: page, total_room_count_estimate: chunks.length };
  if (limit && offset + limit < chunks.length) out.next_batch = `o${offset + limit}`;
  if (offset > 0) out.prev_batch = `o${Math.max(0, offset - (limit ?? 0))}`;
  return out;
}

async function canDeleteAlias(hs: Homeserver, s: Session, alias: Record<string, any>): Promise<boolean> {
  if (alias.creator === s.userId || s.isAdmin) return true;
  const version = await hs.rooms.roomVersion(alias.room_id);
  if (!version) return false;
  const state = await hs.rooms.currentState(alias.room_id);
  const pl = powerLevels(state, version);
  const needed = pl.events["m.room.canonical_alias"] ?? pl.state_default;
  return membershipOf(state, s.userId) === "join" && userLevel(pl, s.userId) >= needed;
}

async function upgradeRoom(hs: Homeserver, s: Session, roomId: string, newVersion: string, additionalCreators?: unknown): Promise<string> {
  if (!SUPPORTED_ROOM_VERSIONS.includes(newVersion)) throw errors.unsupportedRoomVersion();
  const version = await requireRoom(hs, roomId);
  const state = await hs.rooms.requireJoined(roomId, s.userId);
  const pl = powerLevels(state, version);
  const tombstoneLevel = pl.events["m.room.tombstone"] ?? pl.state_default;
  if (userLevel(pl, s.userId) < tombstoneLevel) throw errors.forbidden("You cannot upgrade this room");

  const create = getState(state, "m.room.create")!;
  const creationContent: Record<string, any> = {};
  for (const k of ["m.federate", "type"]) if (create.content[k] !== undefined) creationContent[k] = create.content[k];
  const toV12 = roomVersionFeatures(newVersion).v12;
  if (toV12) {
    // v12 predecessors only reference the room; creators may be added explicitly.
    creationContent.predecessor = { room_id: roomId };
    if (additionalCreators !== undefined) creationContent.additional_creators = additionalCreators;
  } else {
    const lastEvent = (
      await hs.db.findMany("events", {
        where: [{ field: "room_id", value: roomId }],
        sortBy: { field: "stream", direction: "desc" },
        limit: 1,
      })
    )[0];
    creationContent.predecessor = { room_id: roomId, event_id: lastEvent.event_id };
  }

  const copyTypes = [
    "m.room.server_acl",
    "m.room.encryption",
    "m.room.name",
    "m.room.avatar",
    "m.room.topic",
    "m.room.guest_access",
    "m.room.history_visibility",
    "m.room.join_rules",
    "m.room.power_levels",
  ];
  const initialState: any[] = [];
  for (const t of copyTypes) {
    const ev = getState(state, t);
    if (ev && t !== "m.room.power_levels") initialState.push({ type: t, state_key: "", content: ev.content });
  }
  let oldPl: Record<string, any> = structuredClone(getState(state, "m.room.power_levels")?.content ?? {});
  const isPublic = (await hs.db.findOne("rooms", [{ field: "room_id", value: roomId }]))?.is_public;
  let override: Record<string, any>;
  if (toV12) {
    // Creators of the new room have unlimited power and must not appear in `users`.
    const creators = new Set([s.userId, ...(Array.isArray(additionalCreators) ? additionalCreators : [])]);
    const users = { ...oldPl.users };
    for (const u of creators) delete users[u];
    oldPl = { ...oldPl, users };
    override = oldPl;
  } else {
    const level = userLevel(pl, s.userId);
    override = { ...oldPl, users: { ...oldPl.users, [s.userId]: Number.isFinite(level) ? Math.max(level, 100) : 100 } };
  }
  const { room_id: newRoomId } = await hs.rooms.createRoom(s.userId, {
    room_version: newVersion,
    creation_content: creationContent,
    initial_state: initialState,
    power_level_content_override: override,
    preset: "private_chat",
    visibility: isPublic ? "public" : "private",
  });
  // Restore the original power levels exactly (the creator boost was only needed for setup).
  if (getState(state, "m.room.power_levels") && !toV12) {
    try {
      await hs.rooms.sendEvent(newRoomId, s.userId, { type: "m.room.power_levels", state_key: "", content: oldPl });
    } catch {
      /* keep boosted */
    }
  }

  // Move local aliases to the new room.
  const aliases = await hs.db.findMany("room_aliases", { where: [{ field: "room_id", value: roomId }] });
  for (const a of aliases) await hs.db.update("room_aliases", [{ field: "alias", value: a.alias }], { room_id: newRoomId });
  const canonical = getState(state, "m.room.canonical_alias");
  if (canonical && Object.keys(canonical.content).length) {
    await hs.rooms.sendEvent(roomId, s.userId, { type: "m.room.canonical_alias", state_key: "", content: {} }).catch(() => {});
    await hs.rooms
      .sendEvent(newRoomId, s.userId, { type: "m.room.canonical_alias", state_key: "", content: canonical.content })
      .catch(() => {});
  }
  if (isPublic) {
    await hs.db.update("rooms", [{ field: "room_id", value: roomId }], { is_public: false });
  }

  await hs.rooms.sendEvent(roomId, s.userId, {
    type: "m.room.tombstone",
    state_key: "",
    content: { body: "This room has been replaced", replacement_room: newRoomId },
  });
  // Restrict the old room so people move over.
  const restricted = { ...oldPl, events_default: Math.max(50, oldPl.events_default ?? 0), invite: Math.max(50, oldPl.invite ?? 0) };
  await hs.rooms.sendEvent(roomId, s.userId, { type: "m.room.power_levels", state_key: "", content: restricted }).catch(() => {});
  return newRoomId;
}

export function registerRoomRoutes(r: Router): void {
  // The room service checks the createRoom request in detail.
  r.client("POST", "/createRoom", { input: body({}) }, async (ctx) => {
    const s = await ctx.auth();
    if (s.isGuest) throw errors.forbidden("Guests cannot create rooms");
    await assertNotSuspended(ctx.hs, s);
    await ctx.rateLimit("createRoom");
    const created = await ctx.hs.rooms.createRoom(s.userId, ctx.input);
    await ctx.hs.audit.record({ action: "room_create", actor: s.userId, target: created.room_id, ip: ctx.ip });
    return created;
  });

  r.client("GET", "/joined_rooms", async (ctx) => {
    const s = await ctx.auth();
    return { joined_rooms: await ctx.hs.rooms.roomsForUser(s.userId) };
  });

  // Unknown keys of a join request become part of the membership event's content.
  const joinBody = body({ reason: lenient(z.string()), third_party_signed: z.unknown().optional() });
  const join = async (ctx: RequestContext<z.output<typeof joinBody>>, idOrAlias: string) => {
    const s = await ctx.auth();
    await ctx.rateLimit("join");
    const body = ctx.input;
    const { roomId, servers: resolvedServers } = await ctx.hs.rooms.resolveRoom(idOrAlias);
    await assertNotSuspended(ctx.hs, s, roomId);
    const { reason, membership, join_authorised_via_users_server, third_party_signed, ...custom } = body;
    const servers = [...ctx.query.getAll("via"), ...ctx.query.getAll("server_name"), ...resolvedServers];
    // Joining with an identity server's proof first turns the pending third-party invite into an invite.
    if (isObject(third_party_signed)) {
      const signed = third_party_signed as Record<string, any>;
      if (typeof signed.sender !== "string" || signed.mxid !== s.userId || typeof signed.token !== "string")
        throw errors.badJson("Invalid third_party_signed");
      // The identity server's signature covers the whole object (sender included): pass it on unchanged.
      const sender: string = signed.sender;
      const proof = signed;
      if ((await ctx.hs.rooms.membership(roomId, s.userId)) !== "invite") {
        const event = {
          type: "m.room.member",
          room_id: roomId,
          sender,
          state_key: s.userId,
          content: { membership: "invite", third_party_invite: { signed: proof } },
        };
        if (ctx.hs.isLocalUser(sender)) {
          const pending = getState(await ctx.hs.rooms.currentState(roomId), "m.room.third_party_invite", signed.token);
          if (!pending || pending.sender !== sender) throw errors.forbidden("No such third-party invite");
          await ctx.hs.rooms.invite(roomId, sender, s.userId, {
            thirdPartyInvite: { display_name: pending.content?.display_name ?? "", signed: proof },
          });
        } else {
          await ctx.hs.federation.client.request(
            sender.slice(sender.indexOf(":") + 1),
            "PUT",
            `/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(roomId)}`,
            { body: event },
          );
        }
      }
    }
    await ctx.hs.rooms.join(s.userId, roomId, { reason, content: custom, servers });
    return { room_id: roomId };
  };
  r.client("POST", "/rooms/:roomId/join", { input: joinBody }, (ctx) => join(ctx, ctx.params.roomId));
  r.client("POST", "/join/:roomIdOrAlias", { input: joinBody }, (ctx) => join(ctx, ctx.params.roomIdOrAlias));

  r.client("POST", "/knock/:roomIdOrAlias", { input: body({ reason: lenient(z.string()) }) }, async (ctx) => {
    const s = await ctx.auth();
    const body = ctx.input;
    const { roomId, servers } = await ctx.hs.rooms.resolveRoom(ctx.params.roomIdOrAlias);
    await assertNotSuspended(ctx.hs, s, roomId);
    const via = [...ctx.query.getAll("via"), ...ctx.query.getAll("server_name"), ...servers];
    await ctx.hs.rooms.setMembership(roomId, s.userId, s.userId, "knock", body.reason, via);
    return { room_id: roomId };
  });

  // Third-party invites (id_server, medium, address...) are checked in inviteByThreepid.
  const inviteBody = body({ user_id: lenient(z.string()), reason: lenient(z.string()) });
  r.client("POST", "/rooms/:roomId/invite", { input: inviteBody }, async (ctx) => {
    const s = await ctx.auth();
    const body = ctx.input;
    await assertNotSuspended(ctx.hs, s, ctx.params.roomId);
    await ctx.rateLimit("invite");
    if (body.id_server !== undefined || body.medium !== undefined) return inviteByThreepid(ctx, s, body);
    if (!body.user_id || !isValidUserId(body.user_id)) throw errors.invalidParam("Invalid user_id");
    await requireRoom(ctx.hs, ctx.params.roomId);
    const current = await ctx.hs.rooms.membership(ctx.params.roomId, body.user_id);
    if (current === "ban") throw errors.forbidden("User is banned");
    if (current === "join") throw errors.forbidden("User is already joined");
    await ctx.hs.rooms.invite(ctx.params.roomId, s.userId, body.user_id, { reason: body.reason });
    return {};
  });

  r.client("POST", "/rooms/:roomId/leave", { input: membershipBody }, (ctx) => sendMembership(ctx, "leave"));
  r.client("POST", "/rooms/:roomId/kick", { input: membershipBody }, (ctx) => sendMembership(ctx, "kick"));
  r.client("POST", "/rooms/:roomId/ban", { input: membershipBody }, (ctx) => sendMembership(ctx, "ban"));
  r.client("POST", "/rooms/:roomId/unban", { input: membershipBody }, (ctx) => sendMembership(ctx, "unban"));

  r.client("POST", "/rooms/:roomId/forget", async (ctx) => {
    const s = await ctx.auth();
    const hs = ctx.hs;
    const row = await hs.db.findOne("memberships", [
      { field: "room_id", value: ctx.params.roomId },
      { field: "user_id", value: s.userId },
    ]);
    if (!row) throw errors.notFound("Not a member of this room");
    if (row.membership === "join" || row.membership === "invite" || row.membership === "knock") {
      throw errors.unknown("You must leave the room before forgetting it");
    }
    await hs.db.update(
      "memberships",
      [
        { field: "room_id", value: ctx.params.roomId },
        { field: "user_id", value: s.userId },
      ],
      { forgotten: true },
    );
    return {};
  });

  r.client("PUT", "/rooms/:roomId/send/:eventType/:txnId", async (ctx) => {
    const s = await ctx.auth();
    await ctx.rateLimit("message");
    const content = await ctx.json();
    await requireRoom(ctx.hs, ctx.params.roomId);
    // Redactions sent through /send follow the same rule as /redact: own events only while suspended.
    if (!(s.suspended && ctx.params.eventType === "m.room.redaction" && (await ownEvent(ctx.hs, s.userId, content?.redacts)))) {
      await assertNotSuspended(ctx.hs, s, ctx.params.roomId);
    }
    const delay = ctx.query.get("org.matrix.msc4140.delay");
    if (delay !== null) {
      return {
        delay_id: await ctx.hs.delayedEvents.schedule({
          userId: s.userId,
          deviceId: s.deviceId,
          roomId: ctx.params.roomId,
          type: ctx.params.eventType,
          content,
          delayMs: Number(delay),
          txnId: ctx.params.txnId,
        }),
      };
    }
    const ts = s.appservice && ctx.query.get("ts") ? Number(ctx.query.get("ts")) : undefined;
    const eventId = await ctx.hs.rooms.sendEvent(
      ctx.params.roomId,
      s.userId,
      { type: ctx.params.eventType, content },
      { txnId: ctx.params.txnId, deviceId: s.deviceId || undefined, ts },
    );
    return { event_id: eventId };
  });

  const putState = async (ctx: RequestContext) => {
    const s = await ctx.auth();
    const content = await ctx.json();
    const roomId = ctx.params.roomId;
    await requireRoom(ctx.hs, roomId);
    const type = ctx.params.eventType;
    const key = ctx.params.stateKey ?? "";
    if (!(type === "m.room.member" && key === s.userId && content?.membership === "leave")) await assertNotSuspended(ctx.hs, s, roomId);
    await validateStateEvent(ctx.hs, roomId, type, content, key);
    const delay = ctx.query.get("org.matrix.msc4140.delay");
    if (delay !== null) {
      return {
        delay_id: await ctx.hs.delayedEvents.schedule({
          userId: s.userId,
          deviceId: s.deviceId,
          roomId,
          type,
          stateKey: key,
          content,
          delayMs: Number(delay),
        }),
      };
    }
    // Sending identical state again is a no-op that returns the existing event.
    const current = getState(await ctx.hs.rooms.currentState(roomId), type, key);
    if (current && current.sender === s.userId && JSON.stringify(current.content) === JSON.stringify(content)) {
      return { event_id: current.event_id };
    }
    const ts = s.appservice && ctx.query.get("ts") ? Number(ctx.query.get("ts")) : undefined;
    const eventId = await ctx.hs.rooms.sendEvent(roomId, s.userId, { type, state_key: key, content }, { ts });
    return { event_id: eventId };
  };
  r.client("PUT", "/rooms/:roomId/state/:eventType", putState);
  r.client("PUT", "/rooms/:roomId/state/:eventType/:stateKey", putState);

  const getStateEvent = async (ctx: RequestContext) => {
    const s = await ctx.auth();
    const state = await visibleState(ctx.hs, ctx.params.roomId, s.userId);
    const ev = getState(state, ctx.params.eventType, ctx.params.stateKey ?? "");
    if (!ev) throw errors.notFound("State event not found");
    if (ctx.query.get("format") === "event")
      return ctx.hs.rooms.formatEvent({ pdu: ev, stream: 0, snapshot: 0, txnId: null, txnToken: null });
    return ev.content;
  };
  r.client("GET", "/rooms/:roomId/state/:eventType", getStateEvent);
  r.client("GET", "/rooms/:roomId/state/:eventType/:stateKey", getStateEvent);

  r.client("GET", "/rooms/:roomId/state", async (ctx) => {
    const s = await ctx.auth();
    const state = await visibleState(ctx.hs, ctx.params.roomId, s.userId);
    return [...state.values()].map((ev) => toClientEvent(ev)) as unknown as Record<string, unknown>;
  });

  r.client("GET", "/rooms/:roomId/members", async (ctx) => {
    const s = await ctx.auth();
    const hs = ctx.hs;
    // The member list is only known once a partial-state join has completed (MSC3902).
    await hs.partialState.waitForFullState(ctx.params.roomId, ctx.request.signal);
    let state = await visibleState(hs, ctx.params.roomId, s.userId);
    const at = parseToken(ctx.query.get("at"));
    if (at !== null) {
      const rows = await hs.db.findMany("events", {
        where: [
          { field: "room_id", value: ctx.params.roomId },
          { field: "stream", operator: "lte", value: at },
        ],
        sortBy: { field: "stream", direction: "desc" },
        limit: 1,
      });
      if (rows[0]) {
        state = await hs.rooms.stateAtSnapshot(rows[0].state_snapshot);
      } else {
        // Tokens from before the room existed resolve to the room's initial state (creator joined).
        const first = await hs.db.findMany("events", {
          where: [{ field: "room_id", value: ctx.params.roomId }],
          sortBy: { field: "stream", direction: "asc" },
          limit: 2,
        });
        if (first.length) state = await hs.rooms.stateAtSnapshot(first[first.length - 1].state_snapshot);
      }
    }
    const membership = ctx.query.get("membership");
    const notMembership = ctx.query.get("not_membership");
    const chunk = [];
    for (const [k, ev] of state) {
      if (splitStateKey(k)[0] !== "m.room.member") continue;
      const m = ev.content?.membership;
      if (membership && m !== membership) continue;
      if (notMembership && m === notMembership) continue;
      chunk.push(toClientEvent(ev));
    }
    return { chunk };
  });

  r.client("GET", "/rooms/:roomId/joined_members", async (ctx) => {
    const s = await ctx.auth();
    await requireRoom(ctx.hs, ctx.params.roomId);
    await ctx.hs.partialState.waitForFullState(ctx.params.roomId, ctx.request.signal);
    const { joined: isJoined, worldReadable } = await ctx.hs.rooms.canPeek(ctx.params.roomId, s.userId);
    if (!isJoined && !worldReadable) throw errors.forbidden("You are not joined to this room");
    const state = await ctx.hs.rooms.currentState(ctx.params.roomId);
    const joined: Record<string, any> = {};
    for (const [k, ev] of state) {
      const [type, key] = splitStateKey(k);
      if (type !== "m.room.member" || ev.content?.membership !== "join") continue;
      joined[key] = { display_name: ev.content.displayname ?? null, avatar_url: ev.content.avatar_url ?? null };
    }
    return { joined };
  });

  r.client("GET", "/rooms/:roomId/messages", async (ctx) => {
    const s = await ctx.auth();
    const hs = ctx.hs;
    const roomId = ctx.params.roomId;
    await visibleState(hs, roomId, s.userId);
    const dir = ctx.query.get("dir") ?? "b";
    if (dir !== "b" && dir !== "f") throw errors.invalidParam("dir must be 'b' or 'f'");
    const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "10", 10) || 10, 1), 1000);
    const filter = parseRoomEventFilter(ctx);
    const fromRaw = ctx.query.get("from");
    const from: PageToken | null = parsePageToken(fromRaw) ?? (dir === "b" ? { depth: null, stream: await hs.streams.position() } : null);
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
        .map((u) => getState(current, "m.room.member", u))
        .filter(Boolean)
        .map((e) => toClientEvent(e!));
    }
    return out;
  });

  r.client("GET", "/rooms/:roomId/event/:eventId", async (ctx) => {
    const s = await ctx.auth();
    const hs = ctx.hs;
    await requireRoom(hs, ctx.params.roomId);
    const ev = await hs.rooms.getEvent(ctx.params.eventId);
    if (!ev || ev.pdu.room_id !== ctx.params.roomId) throw errors.notFound("Event not found");
    const visible = await hs.rooms.filterVisible(s.userId, ctx.params.roomId, [ev]);
    if (visible.length === 0) throw errors.notFound("Event not found");
    return hs.rooms.formatEvent(ev, viewerOf(s)) as unknown as Record<string, unknown>;
  });

  r.client("GET", "/rooms/:roomId/context/:eventId", async (ctx) => {
    const s = await ctx.auth();
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
  });

  r.client("PUT", "/rooms/:roomId/redact/:eventId/:txnId", async (ctx) => {
    const s = await ctx.auth();
    const body = await ctx.json();
    const roomId = ctx.params.roomId;
    await requireRoom(ctx.hs, roomId);
    if (!(await ownEvent(ctx.hs, s.userId, ctx.params.eventId))) await assertNotSuspended(ctx.hs, s, roomId);
    await ctx.hs.rooms.checkRedactionAllowed(roomId, s.userId, ctx.params.eventId);
    const content: Record<string, any> = {};
    if (typeof body.reason === "string") content.reason = body.reason;
    const eventId = await ctx.hs.rooms.sendEvent(
      roomId,
      s.userId,
      { type: "m.room.redaction", content, redacts: ctx.params.eventId },
      { txnId: ctx.params.txnId, deviceId: s.deviceId },
    );
    return { event_id: eventId };
  });

  r.client("PUT", "/rooms/:roomId/typing/:userId", async (ctx) => {
    const s = await ctx.auth();
    if (ctx.params.userId !== s.userId) throw errors.forbidden("Cannot set typing for another user");
    const body = await ctx.json();
    if (typeof body.typing !== "boolean") throw errors.badJson("typing must be a boolean");
    await ctx.hs.rooms.requireJoined(ctx.params.roomId, s.userId);
    await ctx.hs.typing.setTyping(ctx.params.roomId, s.userId, body.typing, Number(body.timeout) || 30000);
    return {};
  });

  const RECEIPT_TYPES = ["m.read", "m.read.private", "m.fully_read"];
  const setReceipt = async (hs: Homeserver, s: Session, roomId: string, type: string, eventId: string, threadId?: string) => {
    if (type === "m.fully_read") {
      await hs.streams.write((stream) =>
        hs.db.upsert("account_data", { user_id: s.userId, room_id: roomId, type: "m.fully_read", content: { event_id: eventId }, stream }),
      );
      hs.notifier.notify([s.userId]);
      return;
    }
    const ev = await hs.rooms.getEvent(eventId);
    if (!ev || ev.pdu.room_id !== roomId) throw errors.notFound("Event not found");
    await hs.streams.write((stream) =>
      hs.db.upsert("receipts", {
        room_id: roomId,
        user_id: s.userId,
        receipt_type: type,
        thread_id: threadId ?? "",
        event_id: eventId,
        ts: Date.now(),
        stream,
      }),
    );
    hs.notifier.notify(type === "m.read.private" ? [s.userId] : await hs.rooms.joinedMembers(roomId));
    await hs.federation.onReceipt(roomId, s.userId, type, eventId, Date.now(), threadId ?? "").catch(() => {});
  };

  const receiptBody = body({
    thread_id: z.string(fail("M_INVALID_PARAM", "Invalid thread_id")).min(1, "M_INVALID_PARAM: Invalid thread_id").optional(),
  });
  r.client("POST", "/rooms/:roomId/receipt/:receiptType/:eventId", { input: receiptBody }, async (ctx) => {
    const s = await ctx.auth();
    if (!RECEIPT_TYPES.includes(ctx.params.receiptType)) throw errors.invalidParam("Unknown receipt type");
    const body = ctx.input;
    await ctx.hs.rooms.requireJoined(ctx.params.roomId, s.userId);
    await setReceipt(ctx.hs, s, ctx.params.roomId, ctx.params.receiptType, ctx.params.eventId, body.thread_id);
    return {};
  });

  // Keys are receipt types; values that are not event IDs are ignored.
  r.client("POST", "/rooms/:roomId/read_markers", { input: body({}) }, async (ctx) => {
    const s = await ctx.auth();
    const body: Record<string, unknown> = ctx.input;
    await ctx.hs.rooms.requireJoined(ctx.params.roomId, s.userId);
    for (const type of RECEIPT_TYPES) {
      const eventId = body[type];
      if (typeof eventId === "string") await setReceipt(ctx.hs, s, ctx.params.roomId, type, eventId);
    }
    return {};
  });

  // --- Aliases & directory ---------------------------------------------------

  r.client("GET", "/directory/room/:alias", async (ctx) => {
    if (!isValidAlias(ctx.params.alias)) throw errors.invalidParam("Invalid alias");
    const { roomId, servers } = await ctx.hs.rooms.resolveRoom(ctx.params.alias);
    const inRoom = (await ctx.hs.rooms.exists(roomId))
      ? [...(await ctx.hs.federation.roomDestinations(roomId, await ctx.hs.rooms.currentState(roomId)))]
      : [];
    return { room_id: roomId, servers: [...new Set([...servers, ...inRoom])] };
  });

  r.client("PUT", "/directory/room/:alias", async (ctx) => {
    const s = await ctx.auth();
    const body = await ctx.json();
    const alias = ctx.params.alias;
    if (!isValidAlias(alias) || /\s/.test(alias)) throw errors.invalidParam("Invalid alias");
    if (parseId(alias, "#")!.server !== ctx.hs.serverName) throw errors.invalidParam("Alias must be on this server");
    if (!isValidRoomId(body.room_id)) throw errors.invalidParam("Invalid room_id");
    if (!(await ctx.hs.rooms.exists(body.room_id))) throw errors.notFound("Room not found");
    const owner = ctx.hs.appservices.exclusiveAliasOwner(alias);
    if (owner && s.appservice !== owner) throw errors.exclusive("This alias is reserved by an application service");
    if (await ctx.hs.db.findOne("room_aliases", [{ field: "alias", value: alias }])) {
      throw new MatrixError(409, "M_UNKNOWN", "Room alias already exists");
    }
    await ctx.hs.db.create("room_aliases", { alias, room_id: body.room_id, creator: s.userId });
    return {};
  });

  r.client("DELETE", "/directory/room/:alias", async (ctx) => {
    const s = await ctx.auth();
    const row = await ctx.hs.db.findOne("room_aliases", [{ field: "alias", value: ctx.params.alias }]);
    if (!row) throw errors.notFound("Room alias not found");
    if (!(await canDeleteAlias(ctx.hs, s, row))) throw errors.forbidden("You may not delete this alias");
    await ctx.hs.db.delete("room_aliases", [{ field: "alias", value: ctx.params.alias }]);
    // Remove the alias from the room's canonical alias event, too.
    const canonical = getState(await ctx.hs.rooms.currentState(row.room_id), "m.room.canonical_alias");
    if (canonical) {
      const content = { ...canonical.content };
      let changed = false;
      if (content.alias === ctx.params.alias) {
        delete content.alias;
        changed = true;
      }
      if (Array.isArray(content.alt_aliases) && content.alt_aliases.includes(ctx.params.alias)) {
        content.alt_aliases = content.alt_aliases.filter((a: string) => a !== ctx.params.alias);
        changed = true;
      }
      if (changed) {
        await ctx.hs.rooms.sendEvent(row.room_id, s.userId, { type: "m.room.canonical_alias", state_key: "", content }).catch(() => {});
      }
    }
    return {};
  });

  r.client("GET", "/rooms/:roomId/aliases", async (ctx) => {
    const s = await ctx.auth();
    await visibleState(ctx.hs, ctx.params.roomId, s.userId);
    const rows = await ctx.hs.db.findMany("room_aliases", { where: [{ field: "room_id", value: ctx.params.roomId }] });
    return { aliases: rows.map((r) => r.alias) };
  });

  r.client("GET", "/directory/list/room/:roomId", async (ctx) => {
    const row = await ctx.hs.db.findOne("rooms", [{ field: "room_id", value: ctx.params.roomId }]);
    if (!row) throw errors.notFound("Room not found");
    return { visibility: row.is_public ? "public" : "private" };
  });

  r.client("PUT", "/directory/list/room/:roomId", async (ctx) => {
    const s = await ctx.auth();
    const body = await ctx.json();
    if (!["public", "private"].includes(body.visibility)) throw errors.invalidParam("Invalid visibility");
    const version = await ctx.hs.rooms.roomVersion(ctx.params.roomId);
    if (!version) throw errors.notFound("Room not found");
    const state = await ctx.hs.rooms.requireJoined(ctx.params.roomId, s.userId);
    const pl = powerLevels(state, version);
    if (!s.isAdmin && userLevel(pl, s.userId) < (pl.events["m.room.canonical_alias"] ?? pl.state_default)) {
      throw errors.forbidden("Insufficient power level");
    }
    await ctx.hs.db.update("rooms", [{ field: "room_id", value: ctx.params.roomId }], { is_public: body.visibility === "public" });
    return {};
  });

  const remoteOrLocal = async (ctx: RequestContext, body: Record<string, any>) => {
    const server = ctx.query.get("server");
    if (server && server !== ctx.hs.serverName) {
      const query: Record<string, any> = { ...body };
      if (ctx.query.get("limit")) query.limit = Number(ctx.query.get("limit"));
      if (ctx.query.get("since")) query.since = ctx.query.get("since");
      return ctx.hs.federation.queryPublicRooms(server, query);
    }
    return publicRooms(ctx, body);
  };
  r.client("GET", "/publicRooms", (ctx) => remoteOrLocal(ctx, {}));
  // The directory query (limit, since, filter...) is read leniently by remoteOrLocal.
  r.client("POST", "/publicRooms", { input: body({}) }, async (ctx) => {
    await ctx.auth();
    return remoteOrLocal(ctx, ctx.input);
  });

  const upgradeBody = body({
    new_version: z.string(fail("M_BAD_JSON", "Missing new_version")),
    additional_creators: z.unknown().optional(),
  });
  r.client("POST", "/rooms/:roomId/upgrade", { input: upgradeBody }, async (ctx) => {
    const s = await ctx.auth();
    const body = ctx.input;
    return { replacement_room: await upgradeRoom(ctx.hs, s, ctx.params.roomId, body.new_version, body.additional_creators) };
  });

  // --- Content reports ------------------------------------------------------------
  const reportBody = body({
    score: z
      .number(fail("M_INVALID_PARAM", "score must be between -100 and 0"))
      .int("M_INVALID_PARAM: score must be between -100 and 0")
      .min(-100, "M_INVALID_PARAM: score must be between -100 and 0")
      .max(0, "M_INVALID_PARAM: score must be between -100 and 0")
      .optional(),
    reason: z.string(fail("M_BAD_JSON", "reason must be a string")).optional(),
  });
  const report = async (ctx: RequestContext<z.output<typeof reportBody>>) => {
    const s = await ctx.auth();
    const hs = ctx.hs;
    const roomId = ctx.params.roomId;
    await requireRoom(hs, roomId);
    if (ctx.params.eventId) {
      const ev = await hs.rooms.getEvent(ctx.params.eventId);
      // Reporters must be able to see the event; otherwise pretend it does not exist.
      if (!ev || ev.pdu.room_id !== roomId || !(await hs.rooms.filterVisible(s.userId, roomId, [ev])).length)
        throw errors.notFound("Event not found");
    } else if ((await hs.rooms.membership(roomId, s.userId)) !== "join") {
      throw errors.notFound("Room not found");
    }
    // Validated only now: a report about an event the reporter cannot see is a 404 whatever the body.
    const body = ctx.input;
    const id = await hs.cluster.nextId("event_reports");
    await hs.db.create("event_reports", {
      id,
      ts: Date.now(),
      room_id: roomId,
      event_id: ctx.params.eventId ?? null,
      reporter: s.userId,
      reason: body.reason ?? null,
      score: body.score ?? null,
      resolved: false,
    });
    await hs.audit.record({
      action: "event_report",
      actor: s.userId,
      target: ctx.params.eventId ?? roomId,
      details: { room_id: roomId, report_id: id },
    });
    if (hs.adminRoom) {
      void hs.adminRoom
        .say(`New report #${id} from ${s.userId} about ${ctx.params.eventId ?? "room"} in ${roomId}: ${body.reason ?? "(no reason)"}`)
        .catch(() => {});
    }
    return {};
  };
  r.client(
    "POST",
    "/users/:userId/report",
    { input: body({ reason: z.string(fail("M_BAD_JSON", "reason must be a string")) }) },
    async (ctx) => {
      const s = await ctx.auth();
      const hs = ctx.hs;
      const body = ctx.input;
      const userId = ctx.params.userId;
      if (!isValidUserId(userId)) throw errors.invalidParam("Invalid user ID");
      // Only local accounts can be checked; reports about remote users are kept as they are.
      if (hs.isLocalUser(userId) && !(await hs.db.findOne("users", [{ field: "user_id", value: userId }])))
        throw errors.notFound("Unknown user");
      const id = await hs.cluster.nextId("user_reports");
      await hs.db.create("user_reports", { id, ts: Date.now(), user_id: userId, reporter: s.userId, reason: body.reason, resolved: false });
      await hs.audit.record({ action: "user_report", actor: s.userId, target: userId, details: { report_id: id } });
      if (hs.adminRoom)
        void hs.adminRoom.say(`New user report #${id} from ${s.userId} about ${userId}: ${body.reason || "(no reason)"}`).catch(() => {});
      return {};
    },
  );

  r.client(
    "GET",
    "/mutual_rooms",
    async (ctx) => {
      const s = await ctx.auth();
      const other = ctx.query.get("user_id");
      if (other === null) throw errors.missingParam("Missing user_id");
      if (!isValidUserId(other)) throw errors.invalidParam("Invalid user_id");
      if (other === s.userId) throw errors.invalidParam("user_id must not be your own");
      const theirs = new Set(await ctx.hs.rooms.roomsForUser(other));
      const joined = (await ctx.hs.rooms.roomsForUser(s.userId)).filter((r) => theirs.has(r)).sort();
      // Paginated by room ID: `from` is the last room ID of the previous batch.
      const from = ctx.query.get("from");
      const start = from === null ? 0 : joined.findIndex((r) => r > from);
      if (from !== null && !isValidRoomId(from)) throw errors.invalidParam("Invalid from token");
      const page = start < 0 ? [] : joined.slice(start, start + 100);
      const out: Record<string, unknown> = { joined: page, count: joined.length };
      if (start >= 0 && start + 100 < joined.length) out.next_batch = page[page.length - 1];
      return out;
    },
    ["v1"],
  );

  r.client("POST", "/rooms/:roomId/report/:eventId", { input: reportBody }, report);
  r.client("POST", "/rooms/:roomId/report", { input: reportBody }, report);

  r.client("GET", "/admin/whois/:userId", async (ctx) => {
    const s = await ctx.auth();
    const userId = ctx.params.userId;
    if (userId !== s.userId && !s.isAdmin) throw errors.forbidden("Only server admins can look up other users");
    if (!ctx.hs.isLocalUser(userId)) throw errors.notFound("Unknown user");
    const devices = await ctx.hs.db.findMany("devices", { where: [{ field: "user_id", value: userId }] });
    const out: Record<string, any> = {};
    for (const d of devices) {
      out[d.device_id] = { sessions: [{ connections: d.last_seen_ip ? [{ ip: d.last_seen_ip, last_seen: d.last_seen_ts }] : [] }] };
    }
    return { user_id: userId, devices: out };
  });

  // Application service network-specific room directory.
  r.client("PUT", "/directory/list/appservice/:networkId/:roomId", async (ctx) => {
    const s = await ctx.auth();
    if (!s.appservice) throw errors.forbidden("Only application services may use this endpoint");
    const body = await ctx.json();
    if (!["public", "private"].includes(body.visibility)) throw errors.invalidParam("Invalid visibility");
    if (!(await ctx.hs.rooms.exists(ctx.params.roomId))) throw errors.notFound("Room not found");
    await ctx.hs.db.update("rooms", [{ field: "room_id", value: ctx.params.roomId }], { is_public: body.visibility === "public" });
    return {};
  });

  const relVersions = ["v1", "v3"];
  r.client("GET", "/rooms/:roomId/relations/:eventId", relations, relVersions);
  r.client("GET", "/rooms/:roomId/relations/:eventId/:relType", relations, relVersions);
  r.client("GET", "/rooms/:roomId/relations/:eventId/:relType/:eventType", relations, relVersions);
  r.client("GET", "/rooms/:roomId/threads", threads, ["v1"]);

  r.client(
    "GET",
    "/rooms/:roomId/timestamp_to_event",
    async (ctx) => {
      const s = await ctx.auth();
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
              !local || (dir === "f" ? remote.origin_server_ts < local.origin_server_ts : remote.origin_server_ts > local.origin_server_ts);
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
    ["v1", "v3"],
  );
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
    const rel = (row.json as PDU).content?.["m.relates_to"];
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
    const rel = (row.json as PDU).content?.["m.relates_to"];
    if (!isObject(rel) || rel.rel_type !== "m.thread" || typeof rel.event_id !== "string") continue;
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
          "m.relations": {
            ...ev.unsigned?.["m.relations"],
            "m.thread": {
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
