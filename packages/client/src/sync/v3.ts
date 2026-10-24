import type { MatrixHttpApi } from "../http/api.ts";
import type { RawEvent } from "../models/types.ts";
import type { JoinedRoomUpdate, LeftRoomUpdate, SyncRequest, SyncResult, SyncTransport, TimelineUpdate } from "./types.ts";

/** Options for the /sync filter (https://spec.matrix.org/v1.16/client-server-api/#filtering). */
export interface V3SyncOptions {
  /** Timeline events per room in a sync (default 20). */
  timelineLimit?: number;
  /** Lazy-load room members (default true): the client fetches full lists when it needs them. */
  lazyLoadMembers?: boolean;
  /** A filter of your own instead (an ID or a filter object). */
  filter?: string | Record<string, unknown>;
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Record<string, any> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : {};
const events = (v: unknown): RawEvent[] =>
  arr<RawEvent>(obj(v).events).filter((e) => typeof e === "object" && e !== null && typeof e.type === "string");

function timeline(v: unknown): TimelineUpdate {
  const t = obj(v);
  return { events: events(t), limited: t.limited === true, prevBatch: typeof t.prev_batch === "string" ? t.prev_batch : undefined };
}

/** GET /_matrix/client/v3/sync (https://spec.matrix.org/v1.16/client-server-api/#get_matrixclientv3sync). */
export class SyncV3Transport implements SyncTransport {
  readonly kind = "v3";
  private readonly api: MatrixHttpApi;
  private readonly filter: string;

  constructor(api: MatrixHttpApi, opts: V3SyncOptions = {}) {
    this.api = api;
    if (typeof opts.filter === "string") this.filter = opts.filter;
    else {
      const lazy = opts.lazyLoadMembers ?? true;
      this.filter = JSON.stringify(
        opts.filter ?? {
          room: {
            state: { lazy_load_members: lazy },
            timeline: { limit: opts.timelineLimit ?? 20, lazy_load_members: lazy },
          },
        },
      );
    }
  }

  async sync(req: SyncRequest): Promise<SyncResult> {
    const res = await this.api.request("GET", "/v3/sync", {
      query: { since: req.since, timeout: req.timeoutMs, filter: this.filter, set_presence: req.setPresence },
      signal: req.signal,
      // The server holds the request for up to timeoutMs; allow for the network on top.
      timeoutMs: req.timeoutMs + 30_000,
    });
    return parseV3(res, req.since === undefined);
  }
}

export function parseV3(res: Record<string, any>, initial: boolean): SyncResult {
  if (typeof res.next_batch !== "string") throw new Error("Sync response has no next_batch");
  const rooms = obj(res.rooms);
  const join: Record<string, JoinedRoomUpdate> = {};
  for (const [roomId, r] of Object.entries(obj(rooms.join))) {
    const room = obj(r);
    const summary = obj(room.summary);
    join[roomId] = {
      state: events(room.state),
      initial,
      timeline: timeline(room.timeline),
      ephemeral: events(room.ephemeral),
      accountData: events(room.account_data),
      summary: room.summary
        ? {
            heroes: arr<string>(summary["m.heroes"]),
            joinedMemberCount: summary["m.joined_member_count"],
            invitedMemberCount: summary["m.invited_member_count"],
          }
        : undefined,
      unreadNotifications: room.unread_notifications,
    };
  }
  const invited = (section: unknown) => {
    const out: SyncResult["rooms"]["invite"] = {};
    for (const [roomId, r] of Object.entries(obj(section))) {
      out[roomId] = { strippedState: arr(obj(obj(r).invite_state).events) };
    }
    return out;
  };
  const leave: Record<string, LeftRoomUpdate> = {};
  for (const [roomId, r] of Object.entries(obj(rooms.leave))) {
    const room = obj(r);
    leave[roomId] = { state: events(room.state), timeline: timeline(room.timeline), accountData: events(room.account_data) };
  }
  const knock: SyncResult["rooms"]["knock"] = {};
  for (const [roomId, r] of Object.entries(obj(rooms.knock))) knock[roomId] = { strippedState: arr(obj(obj(r).knock_state).events) };
  const deviceLists = obj(res.device_lists);
  return {
    nextBatch: res.next_batch,
    rooms: { join, invite: invited(rooms.invite), leave, knock },
    toDevice: arr(obj(res.to_device).events),
    deviceLists: { changed: arr<string>(deviceLists.changed), left: arr<string>(deviceLists.left) },
    oneTimeKeyCounts: res.device_one_time_keys_count,
    unusedFallbackKeyTypes: Array.isArray(res.device_unused_fallback_key_types) ? res.device_unused_fallback_key_types : undefined,
    accountData: events(res.account_data),
    presence: events(res.presence),
  };
}
