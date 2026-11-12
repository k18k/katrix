import type { ClientEvent, Membership } from "../events.ts";

/** Rooms, membership and room events (https://spec.matrix.org/v1.16/client-server-api/#rooms). */

export interface StateEventInput {
  type: string;
  state_key?: string;
  content: Record<string, unknown>;
}

export interface CreateRoomRequest {
  visibility?: "public" | "private";
  room_alias_name?: string;
  name?: string;
  topic?: string;
  invite?: string[];
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
  third_party_signed?: Record<string, unknown>;
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
  joined: Record<string, { display_name?: string | null; avatar_url?: string | null }>;
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

export interface MembershipFilter {
  membership?: Membership;
  not_membership?: Membership;
}
