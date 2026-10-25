/**
 * Event shapes (https://spec.matrix.org/v1.16/client-server-api/#events), typed by event type.
 * EventContentMap is an interface, so an app can add its own types by declaration merging:
 *
 *   declare module "@katrix/client" {
 *     interface EventContentMap { "com.example.poll": { question: string } }
 *   }
 *
 * Shared by the server and the client (packages/shared); both packages re-export it.
 */

export type Membership = "join" | "invite" | "leave" | "ban" | "knock";

export interface RelatesTo {
  rel_type?: string;
  event_id?: string;
  key?: string;
  is_falling_back?: boolean;
  "m.in_reply_to"?: { event_id: string };
}

export interface MessageContentBase {
  body: string;
  "m.relates_to"?: RelatesTo;
  "m.new_content"?: Record<string, unknown>;
  "m.mentions"?: { user_ids?: string[]; room?: boolean };
  format?: "org.matrix.custom.html";
  formatted_body?: string;
}

export type MessageContent =
  | (MessageContentBase & { msgtype: "m.text" | "m.notice" | "m.emote" })
  | (MessageContentBase & {
      msgtype: "m.image" | "m.file" | "m.audio" | "m.video";
      url?: string;
      file?: EncryptedFile;
      info?: Record<string, unknown>;
      filename?: string;
    })
  | (MessageContentBase & { msgtype: "m.location"; geo_uri: string })
  | (MessageContentBase & { msgtype: string; [k: string]: unknown });

/** An attachment in an encrypted room (https://spec.matrix.org/v1.16/client-server-api/#sending-encrypted-attachments). */
export interface EncryptedFile {
  url: string;
  key: { kty: "oct"; key_ops: string[]; alg: "A256CTR"; k: string; ext: true };
  iv: string;
  hashes: { sha256: string };
  v: "v2";
}

export interface PowerLevelsContent {
  ban?: number;
  kick?: number;
  invite?: number;
  redact?: number;
  events?: Record<string, number>;
  events_default?: number;
  state_default?: number;
  users?: Record<string, number>;
  users_default?: number;
  notifications?: { room?: number };
}

export interface EncryptionContent {
  algorithm: "m.megolm.v1.aes-sha2" | string;
  rotation_period_ms?: number;
  rotation_period_msgs?: number;
}

export interface MegolmEncryptedContent {
  algorithm: "m.megolm.v1.aes-sha2";
  ciphertext: string;
  session_id: string;
  /** Deprecated since v1.3 but still sent for older clients. */
  sender_key?: string;
  device_id?: string;
  "m.relates_to"?: RelatesTo;
}

export interface OlmEncryptedContent {
  algorithm: "m.olm.v1.curve25519-aes-sha2";
  sender_key: string;
  ciphertext: Record<string, { type: 0 | 1; body: string }>;
}

export interface EventContentMap {
  "m.room.message": MessageContent;
  "m.room.encrypted": MegolmEncryptedContent | OlmEncryptedContent;
  "m.room.member": {
    membership: Membership;
    displayname?: string | null;
    avatar_url?: string | null;
    reason?: string;
    is_direct?: boolean;
    join_authorised_via_users_server?: string;
  };
  "m.room.create": {
    creator?: string;
    room_version?: string;
    type?: string;
    "m.federate"?: boolean;
    predecessor?: { room_id: string; event_id?: string };
  };
  "m.room.name": { name: string };
  "m.room.topic": { topic: string };
  "m.room.avatar": { url?: string; info?: Record<string, unknown> };
  "m.room.canonical_alias": { alias?: string | null; alt_aliases?: string[] };
  "m.room.join_rules": {
    join_rule: "public" | "knock" | "invite" | "private" | "restricted" | "knock_restricted";
    allow?: Array<{ type: string; room_id?: string }>;
  };
  "m.room.history_visibility": { history_visibility: "invited" | "joined" | "shared" | "world_readable" };
  "m.room.guest_access": { guest_access: "can_join" | "forbidden" };
  "m.room.power_levels": PowerLevelsContent;
  "m.room.encryption": EncryptionContent;
  "m.room.redaction": { redacts?: string; reason?: string };
  "m.room.pinned_events": { pinned: string[] };
  "m.room.tombstone": { body: string; replacement_room: string };
  "m.room.server_acl": { allow?: string[]; deny?: string[]; allow_ip_literals?: boolean };
  "m.space.child": { via?: string[]; order?: string; suggested?: boolean };
  "m.space.parent": { via?: string[]; canonical?: boolean };
  "m.ignored_user_list": { ignored_users: Record<string, Record<string, never>> };
  "m.reaction": { "m.relates_to": RelatesTo & { rel_type: "m.annotation"; event_id: string; key: string } };
  "m.sticker": { body: string; url: string; info?: Record<string, unknown> };
  "m.typing": { user_ids: string[] };
  "m.receipt": Record<string, Record<string, Record<string, { ts?: number; thread_id?: string }>>>;
  "m.fully_read": { event_id: string };
  "m.direct": Record<string, string[]>;
  "m.tag": { tags: Record<string, { order?: number }> };
  "m.room_key": { algorithm: string; room_id: string; session_id: string; session_key: string };
  "m.room_key.withheld": { algorithm: string; room_id?: string; session_id?: string; sender_key?: string; code: string; reason?: string };
  "m.forwarded_room_key": {
    algorithm: string;
    room_id: string;
    session_id: string;
    session_key: string;
    sender_key: string;
    sender_claimed_ed25519_key: string;
    forwarding_curve25519_key_chain: string[];
  };
  "m.dummy": Record<string, never>;
  "m.presence": {
    presence: "online" | "offline" | "unavailable";
    last_active_ago?: number;
    status_msg?: string;
    currently_active?: boolean;
  };
}

export type KnownEventType = keyof EventContentMap;
export type ContentOf<T extends string> = T extends KnownEventType ? EventContentMap[T] : Record<string, unknown>;

export interface UnsignedData {
  age?: number;
  transaction_id?: string;
  redacted_because?: ClientEvent;
  prev_content?: Record<string, unknown>;
  membership?: Membership;
  "m.relations"?: Record<string, unknown>;
  [k: string]: unknown;
}

/** An event as the server sends it to clients (https://spec.matrix.org/v1.16/client-server-api/#room-event-format). */
export interface ClientEvent<T extends string = string> {
  type: T;
  content: ContentOf<T>;
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  room_id?: string;
  state_key?: string;
  redacts?: string;
  unsigned?: UnsignedData;
}

/** State in an invite or knock (https://spec.matrix.org/v1.16/client-server-api/#stripped-state). */
export interface StrippedStateEvent {
  type: string;
  state_key: string;
  content: Record<string, unknown>;
  sender: string;
}

/** A to-device event (https://spec.matrix.org/v1.16/client-server-api/#send-to-device-messaging). */
export interface ToDeviceEvent {
  type: string;
  sender: string;
  content: Record<string, any>;
}
