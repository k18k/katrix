import { createHash } from "node:crypto";
import { getState } from "../core/authrules.ts";
import { errors } from "../core/errors.ts";
import { toClientEvent, type PDU } from "../core/events.ts";
import { isObject } from "../core/json.ts";
import type { Homeserver } from "../homeserver.ts";
import type { Router } from "../http/router.ts";

// MSC2836: threading via `m.relationship` with tree walks (`/event_relationships`).
// Edges are indexed in `event_edges` as events are persisted or fetched. When a walk reaches
// events this server does not have, or a remote server reports children we do not know about
// (via `children_hash`), the missing part of the tree is fetched over federation.

interface WalkRequest {
  event_id: string;
  room_id?: string;
  max_depth: number;
  max_breadth: number;
  limit: number;
  depth_first: boolean;
  recent_first: boolean;
  include_parent: boolean;
  include_children: boolean;
  direction: "up" | "down";
}

function parseRequest(body: unknown): WalkRequest {
  if (!isObject(body) || typeof body.event_id !== "string") throw errors.badJson("event_id is required");
  const num = (v: unknown, d: number, max: number) => (Number.isInteger(v) && (v as number) >= 0 ? Math.min(v as number, max) : d);
  return {
    event_id: body.event_id,
    room_id: typeof body.room_id === "string" ? body.room_id : undefined,
    max_depth: num(body.max_depth, 3, 50),
    max_breadth: num(body.max_breadth, 10, 100),
    limit: Math.max(num(body.limit, 100, 1000), 1),
    depth_first: body.depth_first === true,
    recent_first: body.recent_first !== false,
    include_parent: body.include_parent === true,
    include_children: body.include_children === true,
    direction: body.direction === "up" ? "up" : "down",
  };
}

export function relationshipOf(pdu: PDU): { event_id: string; rel_type: string } | null {
  const rel = pdu.content?.["m.relationship"];
  return isObject(rel) && typeof rel.event_id === "string" && typeof rel.rel_type === "string"
    ? { event_id: rel.event_id, rel_type: rel.rel_type }
    : null;
}

/** Index an event's `m.relationship` edge (idempotent). */
export async function recordEdge(hs: Homeserver, pdu: PDU): Promise<void> {
  const rel = relationshipOf(pdu);
  if (!rel || !pdu.event_id) return;
  await hs.db.upsert("event_edges", {
    event_id: pdu.event_id,
    room_id: pdu.room_id,
    parent_id: rel.event_id,
    rel_type: rel.rel_type,
    ts: pdu.origin_server_ts ?? 0,
    depth: pdu.depth ?? 0,
  });
}

async function children(hs: Homeserver, eventId: string, recentFirst: boolean) {
  const rows = await hs.db.findMany("event_edges", { where: [{ field: "parent_id", value: eventId }] });
  rows.sort((a, b) => (a.ts - b.ts || a.depth - b.depth || a.event_id.localeCompare(b.event_id)) * (recentFirst ? -1 : 1));
  return rows;
}

async function childrenSummary(hs: Homeserver, eventId: string): Promise<{ children: Record<string, number>; children_hash: string }> {
  const rows = await children(hs, eventId, false);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.rel_type] = (counts[r.rel_type] ?? 0) + 1;
  const ids = rows.map((r) => r.event_id).sort();
  return { children: counts, children_hash: createHash("sha256").update(ids.join("")).digest("base64").replace(/=+$/, "") };
}

/** Walk the local tree. `missing` collects referenced events this server does not have. */
async function walk(hs: Homeserver, req: WalkRequest, canSee: (pdu: PDU) => Promise<boolean>, missing: Set<string>) {
  const out: PDU[] = [];
  const seen = new Set<string>();
  let limited = false;
  const push = async (id: string): Promise<boolean> => {
    if (seen.has(id)) return false;
    seen.add(id);
    const pdu = await hs.rooms.getPdu(id);
    if (!pdu) {
      missing.add(id);
      return false;
    }
    if (!(await canSee(pdu))) return false;
    if (out.length >= req.limit) {
      limited = true;
      return false;
    }
    out.push(pdu);
    return true;
  };

  const root = await hs.rooms.getPdu(req.event_id);
  if (!root) {
    missing.add(req.event_id);
    return { events: out, limited, root: null };
  }
  if (!(await canSee(root))) throw errors.forbidden("You cannot see this event");
  await push(req.event_id);
  const parentId = relationshipOf(root)?.event_id;
  if (req.include_parent && parentId) await push(parentId);
  if (req.include_children) for (const c of await children(hs, req.event_id, req.recent_first)) await push(c.event_id);

  if (req.direction === "up") {
    let current: PDU | null = root;
    for (let depth = 0; current && depth < req.max_depth; depth++) {
      const up = relationshipOf(current)?.event_id;
      if (!up) break;
      if (!seen.has(up)) await push(up);
      current = await hs.rooms.getPdu(up);
    }
  } else {
    // Breadth-first (or depth-first) over children, bounded by depth and breadth.
    const queue: { id: string; depth: number }[] = [{ id: req.event_id, depth: 0 }];
    while (queue.length && !limited) {
      const { id, depth } = req.depth_first ? queue.pop()! : queue.shift()!;
      if (depth >= req.max_depth) continue;
      const kids = (await children(hs, id, req.recent_first)).slice(0, req.max_breadth);
      const next: { id: string; depth: number }[] = [];
      for (const kid of kids) {
        if (seen.has(kid.event_id)) continue;
        if (await push(kid.event_id)) next.push({ id: kid.event_id, depth: depth + 1 });
      }
      if (req.depth_first) queue.push(...next.reverse());
      else queue.push(...next);
    }
  }
  return { events: out, limited, root };
}

async function withChildren(hs: Homeserver, pdu: PDU): Promise<PDU> {
  return { ...pdu, unsigned: { ...pdu.unsigned, ...(await childrenSummary(hs, pdu.event_id!)) } };
}

/** Ask the room's other servers for part of the tree and store what they return. */
async function fetchRemote(hs: Homeserver, roomId: string, req: WalkRequest, remoteHashes: Map<string, string>): Promise<boolean> {
  const version = await hs.rooms.roomVersion(roomId);
  if (!version || !hs.federation.enabled) return false;
  const servers = [...hs.federation.serversInRoom(await hs.rooms.currentState(roomId))].filter((s) => s !== hs.serverName);
  for (const server of servers) {
    let res: any;
    try {
      res = await hs.federation.client.request(server, "POST", "/_matrix/federation/unstable/event_relationships", {
        body: { ...req, room_id: roomId },
      });
    } catch (err) {
      hs.logger.debug("event_relationships fetch failed", server, err);
      continue;
    }
    if (!isObject(res) || !Array.isArray(res.events)) continue;
    await hs.federation.storeOutliers(roomId, version, [...(Array.isArray(res.auth_chain) ? res.auth_chain : []), ...res.events]);
    for (const raw of res.events) {
      if (!isObject(raw)) continue;
      const id = hs.federation.computeEventId(raw, version);
      const pdu = id ? await hs.rooms.getPdu(id) : null;
      if (!pdu) continue;
      await recordEdge(hs, pdu);
      if (typeof raw.unsigned?.children_hash === "string") remoteHashes.set(pdu.event_id!, raw.unsigned.children_hash);
    }
    return true;
  }
  return false;
}

export function registerRelationshipRoutes(r: Router): void {
  r.post("/_matrix/client/unstable/event_relationships", async (ctx) => {
    const s = await ctx.auth();
    const hs = ctx.hs;
    const req = parseRequest(await ctx.json());
    const roomOf = async () => req.room_id ?? (await hs.rooms.getPdu(req.event_id))?.room_id ?? null;
    const roomId = await roomOf();
    if (!roomId) throw errors.forbidden("Unknown event");
    if ((await hs.rooms.membership(roomId, s.userId)) !== "join") {
      // Non-members may only read world-readable rooms.
      const hv = getState(await hs.rooms.currentState(roomId), "m.room.history_visibility")?.content?.history_visibility;
      if (hv !== "world_readable") throw errors.forbidden("You are not in this room");
    }
    const canSee = async (pdu: PDU) => {
      if (pdu.room_id !== roomId) return false;
      const ev = await hs.rooms.getEvent(pdu.event_id!);
      if (!ev) return true; // Outliers carry no state; room membership was checked above.
      return (await hs.rooms.filterVisible(s.userId, roomId, [ev])).length > 0;
    };

    // Fill gaps from remote servers until the local view is complete (bounded).
    const asked = new Set<string>();
    const remoteHashes = new Map<string, string>();
    let result: Awaited<ReturnType<typeof walk>> = { events: [], limited: false, root: null };
    for (let round = 0; round < 4; round++) {
      const missing = new Set<string>();
      result = await walk(hs, req, canSee, missing);
      const wanted: WalkRequest[] = [];
      for (const id of missing) {
        if (asked.has(id)) continue;
        asked.add(id);
        wanted.push(id === req.event_id ? req : { ...req, event_id: id, direction: "up", include_parent: false, include_children: false });
      }
      for (const pdu of result.events) {
        const remote = remoteHashes.get(pdu.event_id!);
        if (!remote || asked.has(`children:${pdu.event_id}`)) continue;
        if (remote !== (await childrenSummary(hs, pdu.event_id!)).children_hash) {
          asked.add(`children:${pdu.event_id}`);
          wanted.push({ ...req, event_id: pdu.event_id!, direction: "down", max_depth: 1, include_parent: false, include_children: false });
        }
      }
      if (!wanted.length) break;
      for (const w of wanted) await fetchRemote(hs, roomId, w, remoteHashes);
    }
    if (!result.root) throw errors.notFound("Event not found");
    const events = [];
    for (const pdu of result.events) events.push(toClientEvent(await withChildren(hs, pdu)));
    return { events, limited: result.limited, next_batch: null };
  });
}

/** Server side of `/_matrix/federation/unstable/event_relationships`. */
export async function relationshipsForServer(
  hs: Homeserver,
  origin: string,
  body: unknown,
  authChainOf: (ids: string[]) => Promise<PDU[]>,
) {
  const req = parseRequest(body);
  const root = await hs.rooms.getPdu(req.event_id);
  if (!root) throw errors.notFound("Event not found");
  const roomId = root.room_id;
  if (!hs.federation.serversInRoom(await hs.rooms.currentState(roomId)).has(origin)) throw errors.forbidden("Server is not in this room");
  const result = await walk(hs, req, async (pdu) => pdu.room_id === roomId, new Set());
  const version = (await hs.rooms.roomVersion(roomId))!;
  const events = [];
  for (const pdu of result.events) {
    const wire: Record<string, any> = hs.federation.toFederationPdu(pdu, version);
    wire.unsigned = { ...wire.unsigned, ...(await childrenSummary(hs, pdu.event_id!)) };
    events.push(wire);
  }
  const chain = await authChainOf(result.events.map((p) => p.event_id!));
  return { events, limited: result.limited, auth_chain: chain.map((p) => hs.federation.toFederationPdu(p, version)) };
}
