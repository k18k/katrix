import type { AbortSignalLike } from "../platform.ts";
import type { ClientEvent, ToDeviceEvent } from "@katrix/shared";

/**
 * What one sync round delivers, independent of the protocol that fetched it. /sync v3 maps onto
 * it directly; Simplified Sliding Sync (MSC4186) maps its rooms (required_state → state with
 * `initial` = replace, timeline, bump_stamp) and its extensions (to_device, e2ee, account_data,
 * receipts, typing) onto the same fields. The client processes a SyncResult the same way
 * whichever transport produced it.
 */
export interface SyncResult {
  /** The token for the next round (v3 next_batch; sliding sync `pos`). */
  nextBatch: string;
  rooms: {
    join: Record<string, JoinedRoomUpdate>;
    invite: Record<string, InvitedRoomUpdate>;
    leave: Record<string, LeftRoomUpdate>;
    knock: Record<string, InvitedRoomUpdate>;
  };
  toDevice: ToDeviceEvent[];
  deviceLists: { changed: string[]; left: string[] };
  oneTimeKeyCounts?: Record<string, number>;
  /** undefined: the server does not report it (then fallback keys are not managed). */
  unusedFallbackKeyTypes?: string[];
  accountData: ClientEvent[];
  presence: ClientEvent[];
}

export interface TimelineUpdate {
  events: ClientEvent[];
  /** There is a gap before these events. */
  limited: boolean;
  prevBatch?: string;
}

export interface JoinedRoomUpdate {
  /**
   * State to apply before the timeline (v3 `state`). With `initial`, it is the complete state
   * (a first sync of this room, or sliding sync's `initial: true`): the old state is replaced.
   */
  state: ClientEvent[];
  initial?: boolean;
  timeline: TimelineUpdate;
  ephemeral: ClientEvent[];
  accountData: ClientEvent[];
  summary?: { heroes?: string[]; joinedMemberCount?: number; invitedMemberCount?: number };
  unreadNotifications?: { highlight_count?: number; notification_count?: number };
}

export interface InvitedRoomUpdate {
  strippedState: Array<{ type: string; state_key: string; content: Record<string, unknown>; sender: string }>;
}

export interface LeftRoomUpdate {
  state: ClientEvent[];
  timeline: TimelineUpdate;
  accountData: ClientEvent[];
}

export interface SyncRequest {
  /** undefined for the first sync. */
  since?: string;
  /** Long-poll timeout the server may wait for news. */
  timeoutMs: number;
  signal?: AbortSignalLike;
  /** Ask for presence updates as this state (v3 set_presence). */
  setPresence?: "online" | "offline" | "unavailable";
}

export interface SyncTransport {
  readonly kind: string;
  sync(request: SyncRequest): Promise<SyncResult>;
}
