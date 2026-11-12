import type { ClientEvent, StrippedStateEvent, ToDeviceEvent } from "../events.ts";

/** GET /_matrix/client/v3/sync (https://spec.matrix.org/v1.16/client-server-api/#get_matrixclientv3sync). */

export interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, JoinedRoom>;
    invite?: Record<string, InvitedRoom>;
    leave?: Record<string, LeftRoom>;
    knock?: Record<string, KnockedRoom>;
  };
  account_data?: { events: ClientEvent[] };
  presence?: { events: ClientEvent[] };
  to_device?: { events: ToDeviceEvent[] };
  device_lists?: { changed?: string[]; left?: string[] };
  device_one_time_keys_count?: Record<string, number>;
  device_unused_fallback_key_types?: string[];
}

export interface RoomSummary {
  "m.heroes"?: string[];
  "m.joined_member_count"?: number;
  "m.invited_member_count"?: number;
}

export interface SyncTimeline {
  events: ClientEvent[];
  limited?: boolean;
  prev_batch?: string;
}

export interface JoinedRoom {
  summary?: RoomSummary;
  state?: { events: ClientEvent[] };
  timeline?: SyncTimeline;
  ephemeral?: { events: ClientEvent[] };
  account_data?: { events: ClientEvent[] };
  unread_notifications?: { highlight_count?: number; notification_count?: number };
  unread_thread_notifications?: Record<string, { highlight_count?: number; notification_count?: number }>;
}

export interface InvitedRoom {
  invite_state?: { events: StrippedStateEvent[] };
}

export interface KnockedRoom {
  knock_state?: { events: StrippedStateEvent[] };
}

export interface LeftRoom {
  state?: { events: ClientEvent[] };
  timeline?: SyncTimeline;
  account_data?: { events: ClientEvent[] };
}
