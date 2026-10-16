import type { Schema } from "#storage/types.ts";

const s = { type: "string" } as const;
const sn = { type: "string", required: false } as const;
const n = { type: "number" } as const;
const nn = { type: "number", required: false } as const;
const b = { type: "boolean" } as const;
const bn = { type: "boolean", required: false } as const;
const j = { type: "json" } as const;

export const schema: Schema = {
  users: {
    fields: {
      user_id: s,
      localpart: s,
      password_hash: sn,
      displayname: sn,
      avatar_url: sn,
      is_guest: b,
      is_admin: b,
      deactivated: b,
      created_ts: n,
      // Account moderation (reversible): locked accounts cannot be used, suspended ones only in part.
      locked: bn,
      suspended: bn,
    },
    primaryKey: ["user_id"],
  },
  devices: {
    fields: { user_id: s, device_id: s, display_name: sn, last_seen_ts: nn, last_seen_ip: sn },
    primaryKey: ["user_id", "device_id"],
  },
  access_tokens: {
    fields: { token: s, user_id: s, device_id: s, refresh_token: sn, expires_ts: nn },
    primaryKey: ["token"],
    indexes: [["user_id"], ["refresh_token"]],
  },
  rooms: {
    fields: { room_id: s, room_version: s, creator: s, is_public: b, created_ts: n },
    primaryKey: ["room_id"],
  },
  events: {
    fields: {
      event_id: s,
      room_id: s,
      stream: n,
      depth: n,
      type: s,
      state_key: sn,
      sender: s,
      json: j,
      state_snapshot: n,
      txn_id: sn,
      txn_token: sn,
      redacted_by: sn,
      /** Some prev_events were never fetched: clients must treat the timeline as limited here. */
      gap: { type: "boolean", required: false },
    },
    primaryKey: ["event_id"],
    indexes: [["room_id", "stream"], ["stream"], ["txn_id"]],
  },
  state_snapshots: {
    // `state` holds only the changes relative to `prev`; rows without `prev` are full snapshots.
    fields: { id: n, room_id: s, prev: nn, depth: nn, state: j },
    primaryKey: ["id"],
  },
  relations: {
    fields: { event_id: s, room_id: s, parent_id: s, rel_type: s, type: s, sender: s, stream: n },
    primaryKey: ["event_id"],
    indexes: [["parent_id"], ["room_id", "rel_type"]],
  },
  partial_state_rooms: {
    // MSC3902: rooms joined with partial state; `completed_stream` is set once the full state is known.
    // `pending_device_users`: device list updates received for users we could not place yet.
    fields: {
      room_id: s,
      join_event_id: s,
      origin: s,
      servers: j,
      created_ts: n,
      completed_stream: nn,
      pending_device_users: { type: "json", required: false },
    },
    primaryKey: ["room_id"],
  },
  event_edges: {
    // MSC2836 `m.relationship` edges, for timeline events and outliers alike.
    fields: { event_id: s, room_id: s, parent_id: s, rel_type: s, ts: n, depth: n },
    primaryKey: ["event_id"],
    indexes: [["parent_id"]],
  },
  profile_fields: {
    fields: { user_id: s, field: s, value: { type: "json", required: false }, stream: n },
    primaryKey: ["user_id", "field"],
    indexes: [["stream"]],
  },
  thread_subscriptions: {
    fields: { user_id: s, room_id: s, thread_id: s, subscribed: b, automatic: b, unsubscribed_after: nn, stream: n },
    primaryKey: ["user_id", "room_id", "thread_id"],
    indexes: [["user_id", "stream"]],
  },
  registration_tokens: {
    fields: { token: s, uses_allowed: nn, pending: n, completed: n, expiry_time: nn },
    primaryKey: ["token"],
  },
  notifications: {
    fields: { user_id: s, room_id: s, event_id: s, stream: n, highlight: b, thread_id: s, actions: j, ts: n },
    primaryKey: ["user_id", "event_id"],
    indexes: [
      ["user_id", "room_id"],
      ["user_id", "stream"],
    ],
  },
  sso_identities: {
    fields: { idp_id: s, subject: s, user_id: s },
    primaryKey: ["idp_id", "subject"],
    indexes: [["user_id"]],
  },
  login_tokens: {
    fields: { token: s, user_id: s, expires_ts: n },
    primaryKey: ["token"],
  },
  sliding_sync_connections: {
    fields: { user_id: s, device_id: s, conn_id: s, pos: n, state: j, updated_ts: n },
    primaryKey: ["user_id", "device_id", "conn_id"],
  },
  current_state: {
    fields: { room_id: s, type: s, state_key: s, event_id: s },
    primaryKey: ["room_id", "type", "state_key"],
  },
  memberships: {
    fields: { room_id: s, user_id: s, membership: s, event_id: s, stream: n, forgotten: b },
    primaryKey: ["room_id", "user_id"],
    // https://github.com/k18k/matrix-nodejs-homeserver/issues/28: every incremental /sync asks for
    // the memberships changed since its token; without an index on stream that scanned the table.
    indexes: [["user_id"], ["stream"]],
  },
  room_aliases: {
    fields: { alias: s, room_id: s, creator: s },
    primaryKey: ["alias"],
    indexes: [["room_id"]],
  },
  account_data: {
    fields: { user_id: s, room_id: s, type: s, content: j, stream: n },
    primaryKey: ["user_id", "room_id", "type"],
  },
  receipts: {
    fields: { room_id: s, user_id: s, receipt_type: s, thread_id: s, event_id: s, ts: n, stream: n },
    primaryKey: ["room_id", "user_id", "receipt_type", "thread_id"],
    indexes: [["stream"]],
  },
  to_device: {
    fields: { stream: n, user_id: s, device_id: s, sender: s, type: s, content: j },
    primaryKey: ["stream", "user_id", "device_id"],
    indexes: [["user_id", "device_id"]],
  },
  filters: {
    fields: { user_id: s, filter_id: s, filter: j },
    primaryKey: ["user_id", "filter_id"],
  },
  device_keys: {
    fields: { user_id: s, device_id: s, keys: j, stream: n },
    primaryKey: ["user_id", "device_id"],
  },
  one_time_keys: {
    fields: { user_id: s, device_id: s, key_id: s, algorithm: s, key: j, fallback: b, used: b, seq: n },
    primaryKey: ["user_id", "device_id", "key_id"],
  },
  // Fallback keys have their own key ID space (clients may reuse one-time key IDs), one per algorithm.
  fallback_keys: {
    fields: { user_id: s, device_id: s, algorithm: s, key_id: s, key: j, used: b },
    primaryKey: ["user_id", "device_id", "algorithm"],
  },
  cross_signing_keys: {
    fields: { user_id: s, key_type: s, key: j, stream: n },
    primaryKey: ["user_id", "key_type"],
  },
  key_signatures: {
    fields: { user_id: s, key_id: s, signer: s, signer_key_id: s, signature: s },
    primaryKey: ["user_id", "key_id", "signer", "signer_key_id"],
  },
  device_list_changes: {
    fields: { user_id: s, stream: n },
    primaryKey: ["user_id"],
    indexes: [["stream"]],
  },
  presence: {
    fields: { user_id: s, presence: s, status_msg: sn, last_active_ts: n, stream: n },
    primaryKey: ["user_id"],
  },
  media: {
    fields: { media_id: s, content_type: sn, filename: sn, size: n, uploader: s, created_ts: n, pending: b },
    primaryKey: ["media_id"],
  },
  pushers: {
    fields: { user_id: s, app_id: s, pushkey: s, device_id: sn, pusher: j },
    primaryKey: ["user_id", "app_id", "pushkey"],
  },
  backup_versions: {
    fields: { user_id: s, version: n, algorithm: s, auth_data: j, etag: n, deleted: b },
    primaryKey: ["user_id", "version"],
  },
  backup_keys: {
    fields: { user_id: s, version: n, room_id: s, session_id: s, data: j },
    primaryKey: ["user_id", "version", "room_id", "session_id"],
  },
  remote_server_keys: {
    fields: { server_name: s, key_id: s, key: s, valid_until_ts: n },
    primaryKey: ["server_name", "key_id"],
  },
  outliers: {
    // Events we know about but that are not part of the room timeline: auth/state
    // events received during joins, rejected events and soft-failed events.
    fields: { event_id: s, room_id: s, json: j, state_snapshot: nn, rejected: sn, soft_failed: b },
    primaryKey: ["event_id"],
  },
  forward_extremities: {
    fields: { room_id: s, event_id: s },
    primaryKey: ["room_id", "event_id"],
  },
  federation_outbox: {
    fields: { id: n, destination: s, kind: s, payload: j, created_ts: n },
    primaryKey: ["id"],
    indexes: [["destination"]],
  },
  destination_status: {
    fields: { destination: s, failures: n, retry_after_ts: n },
    primaryKey: ["destination"],
  },
  remote_devices: {
    fields: { user_id: s, device_id: s, keys: j, display_name: sn, stream_id: n },
    primaryKey: ["user_id", "device_id"],
  },
  remote_device_lists: {
    fields: { user_id: s, stream_id: n, stale: b },
    primaryKey: ["user_id"],
  },
  remote_media: {
    fields: { server_name: s, media_id: s, local_id: s, content_type: sn, filename: sn, size: n, fetched_ts: n },
    primaryKey: ["server_name", "media_id"],
  },
  delayed_events: {
    fields: {
      delay_id: s,
      user_id: s,
      device_id: s,
      room_id: s,
      event_type: s,
      state_key: sn,
      content: j,
      delay_ms: n,
      send_at: n,
      running_since: n,
      txn_key: sn,
    },
    primaryKey: ["delay_id"],
    indexes: [["user_id"], ["send_at"], ["room_id"]],
  },
  audit_log: {
    fields: { id: n, ts: n, action: s, actor: sn, target: sn, ip: sn, user_agent: sn, outcome: s, details: j },
    primaryKey: ["id"],
    indexes: [["ts"], ["actor"], ["action"]],
  },
  // Third-party identifiers (email, phone) validated by this server and attached to accounts.
  threepid_sessions: {
    fields: {
      sid: s,
      client_secret: s,
      medium: s,
      address: s,
      token: s,
      send_attempt: n,
      next_link: sn,
      created_ts: n,
      validated_ts: nn,
    },
    primaryKey: ["sid"],
    indexes: [["client_secret"]],
  },
  user_threepids: {
    fields: { user_id: s, medium: s, address: s, validated_ts: n, added_ts: n },
    primaryKey: ["medium", "address"],
    indexes: [["user_id"]],
  },
  /** Identity servers a user's 3PIDs were bound on through this server (to unbind them later). */
  threepid_bindings: {
    fields: { user_id: s, medium: s, address: s, id_server: s },
    primaryKey: ["user_id", "medium", "address", "id_server"],
  },
  user_reports: {
    fields: { id: n, ts: n, user_id: s, reporter: s, reason: s, resolved: b },
    primaryKey: ["id"],
    indexes: [["ts"]],
  },
  event_reports: {
    fields: { id: n, ts: n, room_id: s, event_id: sn, reporter: s, reason: sn, score: nn, resolved: b },
    primaryKey: ["id"],
    indexes: [["room_id"], ["ts"]],
  },
  server_settings: {
    fields: { key: s, value: j },
    primaryKey: ["key"],
  },
  appservice_outbox: {
    fields: { id: n, as_id: s, kind: s, payload: j, created_ts: n },
    primaryKey: ["id"],
    indexes: [["as_id"]],
  },
  server_keys: {
    fields: { key_id: s, seed: s },
    primaryKey: ["key_id"],
  },
};
