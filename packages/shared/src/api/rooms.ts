import type { ClientEvent, Membership, StrippedStateEvent } from "../events.ts";
import type { RoomEventFilter } from "./account.ts";

/** Rooms, membership and room events (https://spec.matrix.org/v1.16/client-server-api/#rooms). */

export interface StateEventInput {
  type: string;
  state_key?: string;
  content: Record<string, unknown>;
}

/** An invite by third-party ID (https://spec.matrix.org/v1.19/client-server-api/#third-party-invites). */
export interface ThirdPartyInvite {
  id_server: string;
  id_access_token: string;
  medium: string;
  address: string;
}

export interface CreateRoomRequest {
  visibility?: "public" | "private";
  room_alias_name?: string;
  name?: string;
  topic?: string;
  invite?: string[];
  invite_3pid?: ThirdPartyInvite[];
  room_version?: string;
  creation_content?: Record<string, unknown>;
  initial_state?: StateEventInput[];
  preset?: "private_chat" | "public_chat" | "trusted_private_chat";
  is_direct?: boolean;
  power_level_content_override?: Record<string, unknown>;
}

export interface CreateRoomResponse {
  room_id: string;
}

export interface JoinRequest {
  reason?: string;
  third_party_signed?: { sender: string; mxid: string; token: string; signatures: Record<string, Record<string, string>> };
}

export interface KnockRequest {
  reason?: string;
}

export interface JoinResponse {
  room_id: string;
}

/** invite, kick, ban, unban. */
export interface MembershipRequest {
  user_id: string;
  reason?: string;
}

export interface LeaveRequest {
  reason?: string;
}

/** PUT …/send/…, …/state/…, …/redact/… */
export interface SendEventResponse {
  event_id: string;
}

/**
 * A send or state request with a delay (MSC4140, `org.matrix.msc4140.delay` query parameter)
 * schedules the event instead of sending it.
 */
export interface DelayedEventResponse {
  delay_id: string;
}

export interface RedactRequest {
  reason?: string;
}

/** GET /rooms/{roomId}/messages */
export interface MessagesResponse {
  chunk: ClientEvent[];
  start: string;
  end?: string;
  state?: ClientEvent[];
}

/** GET /rooms/{roomId}/members */
export interface MembersResponse {
  chunk: ClientEvent[];
}

export interface JoinedMembersResponse {
  joined?: Record<string, { display_name?: string | null; avatar_url?: string | null }>;
}

export interface TypingRequest {
  typing: boolean;
  timeout?: number;
}

export interface ReceiptRequest {
  thread_id?: string;
}

export interface ProfileResponse {
  displayname?: string;
  avatar_url?: string;
  [key: string]: unknown;
}

export interface SetDisplayNameRequest {
  displayname: string;
}

/** PUT /profile/{userId}/{keyName}: `{ [keyName]: value }`. */
export type ProfileFieldBody = Record<string, unknown>;

export interface MembershipFilter {
  membership?: Membership;
  not_membership?: Membership;
}

export interface JoinedRoomsResponse {
  joined_rooms: string[];
}

/** GET /rooms/{roomId}/context/{eventId} */
export interface ContextResponse {
  start?: string;
  end?: string;
  events_before?: ClientEvent[];
  event?: ClientEvent;
  events_after?: ClientEvent[];
  state?: ClientEvent[];
}

/** GET /v1/rooms/{roomId}/relations/{eventId}[/{relType}[/{eventType}]] */
export interface RelationsResponse {
  chunk: ClientEvent[];
  next_batch?: string;
  prev_batch?: string;
  recursion_depth?: number;
}

/** GET /v1/rooms/{roomId}/threads */
export interface ThreadsResponse {
  chunk: ClientEvent[];
  next_batch?: string;
}

export interface TimestampToEventResponse {
  event_id: string;
  origin_server_ts: number;
}

export interface UpgradeRoomRequest {
  new_version: string;
  /** Room versions 12 and later. */
  additional_creators?: string[];
}

export interface UpgradeRoomResponse {
  replacement_room: string;
}

export interface ReadMarkersRequest {
  "m.fully_read"?: string;
  "m.read"?: string;
  "m.read.private"?: string;
}

/** POST /rooms/{roomId}/report and /users/{userId}/report (reason required), …/report/{eventId} (optional). */
export interface ReportRequest {
  reason?: string;
  /** Deprecated, still accepted by servers on …/report/{eventId}. */
  score?: number;
}

export interface MutualRoomsResponse {
  joined: string[];
  count: number;
  next_batch?: string;
}

/** A room in the public room directory, the space hierarchy, or a room summary. */
export interface PublishedRoom {
  room_id: string;
  canonical_alias?: string;
  name?: string;
  topic?: string;
  avatar_url?: string;
  num_joined_members: number;
  world_readable: boolean;
  guest_can_join: boolean;
  join_rule?: string;
  room_type?: string;
}

export interface PublicRoomsResponse {
  chunk: PublishedRoom[];
  next_batch?: string;
  prev_batch?: string;
  total_room_count_estimate?: number;
}

export interface PublicRoomsRequest {
  limit?: number;
  since?: string;
  filter?: { generic_search_term?: string; room_types?: Array<string | null> };
  include_all_networks?: boolean;
  third_party_instance_id?: string;
}

export interface RoomVisibilityBody {
  visibility?: "private" | "public";
}

/** GET /v1/room_summary/{roomIdOrAlias} */
export interface RoomSummaryResponse extends PublishedRoom {
  membership?: Membership;
  encryption?: string;
  room_version?: string;
  allowed_room_ids?: string[];
}

/** GET /v1/rooms/{roomId}/hierarchy */
export interface HierarchyRoom extends PublishedRoom {
  children_state: Array<StrippedStateEvent & { origin_server_ts: number }>;
  encryption?: string;
  room_version?: string;
  allowed_room_ids?: string[];
}

export interface HierarchyResponse {
  rooms: HierarchyRoom[];
  next_batch?: string;
}

export interface AliasResponse {
  room_id?: string;
  servers?: string[];
}

export interface SetAliasRequest {
  room_id: string;
}

export interface RoomAliasesResponse {
  aliases: string[];
}

export interface UserDirectorySearchRequest {
  search_term: string;
  limit?: number;
}

export interface UserDirectorySearchResponse {
  results: Array<{ user_id: string; display_name?: string; avatar_url?: string }>;
  limited: boolean;
}

/** POST /search (https://spec.matrix.org/v1.19/client-server-api/#server-side-search). */
export interface SearchRequest {
  search_categories: {
    room_events?: {
      search_term: string;
      keys?: Array<"content.body" | "content.name" | "content.topic">;
      filter?: RoomEventFilter;
      order_by?: "recent" | "rank";
      event_context?: { before_limit?: number; after_limit?: number; include_profile?: boolean };
      include_state?: boolean;
      groupings?: { group_by?: Array<{ key?: "room_id" | "sender" }> };
    };
  };
}

export interface SearchResult {
  rank?: number;
  result?: ClientEvent;
  context?: {
    start?: string;
    end?: string;
    profile_info?: Record<string, { displayname?: string; avatar_url?: string }>;
    events_before?: ClientEvent[];
    events_after?: ClientEvent[];
  };
}

export interface SearchResponse {
  search_categories: {
    room_events?: {
      count?: number;
      highlights?: string[];
      results?: SearchResult[];
      state?: Record<string, ClientEvent[]>;
      groups?: Record<string, Record<string, { next_batch?: string; order?: number; results?: string[] }>>;
      next_batch?: string;
    };
  };
}

/** GET /notifications */
export interface NotificationsResponse {
  next_token?: string;
  notifications: Array<{
    actions: Array<string | Record<string, unknown>>;
    event: ClientEvent;
    profile_tag?: string;
    read: boolean;
    room_id: string;
    ts: number;
  }>;
}

/** Third-party networks (https://spec.matrix.org/v1.19/client-server-api/#third-party-networks). */
export interface ThirdPartyProtocol {
  user_fields: string[];
  location_fields: string[];
  icon: string;
  field_types: Record<string, { regexp: string; placeholder: string }>;
  instances: Array<{ desc: string; icon?: string; fields: Record<string, unknown>; network_id: string; instance_id?: string }>;
}

export interface ThirdPartyLocation {
  alias: string;
  protocol: string;
  fields: Record<string, unknown>;
}

export interface ThirdPartyUser {
  userid: string;
  protocol: string;
  fields: Record<string, unknown>;
}

/** GET /events?room_id=… (peeking at a world-readable room). */
export interface PeekEventsResponse {
  start?: string;
  end?: string;
  chunk?: ClientEvent[];
}
