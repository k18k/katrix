import type { ContentOf, KnownEventType, ClientEvent, RelatesTo, UnsignedData } from "@katrix/shared";

export type DecryptionStatus = "none" | "pending" | "decrypted" | "failed";

/** Why an event could not be decrypted. */
export type DecryptionFailureCode =
  /** We do not have the Megolm session (yet: keys may arrive later). */
  | "MISSING_ROOM_KEY"
  /** We have the session, but not from this message index on. */
  | "UNKNOWN_MESSAGE_INDEX"
  /** The same session and index was seen with another event: a replay. */
  | "REPLAYED"
  /** The plaintext is for another room than the event's. */
  | "ROOM_MISMATCH"
  /** The session belongs to a different user than the event's sender. */
  | "SENDER_MISMATCH"
  /** Bad MAC, bad signature, malformed message or plaintext. */
  | "BAD_ENCRYPTED_MESSAGE"
  | "UNKNOWN_ALGORITHM";

/** Who sent a decrypted event, as far as the keys tell. */
export interface DecryptionInfo {
  /** Curve25519 key of the device that created the Megolm session. */
  senderCurve25519Key: string;
  /** Ed25519 key that device claimed when it shared the session. */
  claimedEd25519Key?: string;
  /** The sender's device the session is bound to, if its keys are known and match. */
  senderDeviceId?: string;
  /**
   * "authenticated": the session came from a device of the sender whose keys we know and that
   * signed them; "unknown_device": the device's keys are not known (yet); "unauthenticated": the
   * session came from a forwarded key or another source that does not prove its origin.
   * Device verification (SAS, cross-signing) builds on this later.
   */
  authenticity: "authenticated" | "unknown_device" | "unauthenticated";
}

export type LocalEchoStatus = "sending" | "encrypting" | "sent" | "failed" | "cancelled";

/**
 * A room event. For an encrypted event, `type` and `content` are the decrypted ones once it is
 * decrypted; `wire` keeps what the server sent.
 */
export class MatrixEvent<T extends string = string> {
  wire: ClientEvent;
  private clear?: { type: string; content: Record<string, unknown> };
  decryptionStatus: DecryptionStatus = "none";
  decryptionError?: DecryptionFailureCode;
  decryptionInfo?: DecryptionInfo;
  /** For our own events while they are sent. */
  localStatus?: LocalEchoStatus;
  txnId?: string;
  /** Set when a redaction for this event arrived. */
  redactedBy?: string;
  /** The edit shown for this event (the newest valid m.replace), kept up to date by its room. */
  replacement?: MatrixEvent;

  constructor(wire: ClientEvent) {
    this.wire = wire;
    if (wire.type === "m.room.encrypted") this.decryptionStatus = "pending";
  }

  get eventId(): string | undefined {
    return this.wire.event_id;
  }

  get type(): T {
    return (this.clear?.type ?? this.wire.type) as T;
  }

  get content(): ContentOf<T> {
    return (this.clear?.content ?? this.wire.content) as ContentOf<T>;
  }

  get sender(): string | undefined {
    return this.wire.sender;
  }

  get roomId(): string | undefined {
    return this.wire.room_id;
  }

  get stateKey(): string | undefined {
    return this.wire.state_key;
  }

  get originServerTs(): number | undefined {
    return this.wire.origin_server_ts;
  }

  get unsigned(): UnsignedData {
    return this.wire.unsigned ?? {};
  }

  isState(): boolean {
    return this.wire.state_key !== undefined;
  }

  /** Whether the event was sent encrypted (whatever its decryption state). */
  isEncrypted(): boolean {
    return this.wire.type === "m.room.encrypted";
  }

  isRedacted(): boolean {
    return this.redactedBy !== undefined || this.wire.unsigned?.redacted_because !== undefined;
  }

  /**
   * The content to show: an edit's `m.new_content` once the event was edited, with the
   * original's `m.relates_to` kept (https://spec.matrix.org/v1.19/client-server-api/#applying-mnew_content).
   */
  get latestContent(): ContentOf<T> {
    const newContent = this.replacement?.content as { "m.new_content"?: Record<string, unknown> } | undefined;
    if (!newContent?.["m.new_content"] || this.isRedacted()) return this.content;
    const { "m.relates_to": _ignored, ...rest } = newContent["m.new_content"];
    const relatesTo = (this.content as { "m.relates_to"?: unknown })["m.relates_to"];
    return (relatesTo === undefined ? rest : { ...rest, "m.relates_to": relatesTo }) as ContentOf<T>;
  }

  isEdited(): boolean {
    return this.replacement !== undefined && !this.isRedacted();
  }

  /** The event this one replies to (rich replies, https://spec.matrix.org/v1.19/client-server-api/#rich-replies). */
  get replyToEventId(): string | undefined {
    const rel =
      (this.content as { "m.relates_to"?: RelatesTo })["m.relates_to"] ??
      (this.wire.content as { "m.relates_to"?: RelatesTo })["m.relates_to"];
    const id = rel?.["m.in_reply_to"]?.event_id;
    return typeof id === "string" ? id : undefined;
  }

  /** The thread root this event is in, if it is a thread reply. */
  get threadRootId(): string | undefined {
    const rel =
      (this.content as { "m.relates_to"?: RelatesTo })["m.relates_to"] ??
      (this.wire.content as { "m.relates_to"?: RelatesTo })["m.relates_to"];
    return rel?.rel_type === "m.thread" && typeof rel.event_id === "string" ? rel.event_id : undefined;
  }

  /** Narrows the event's type (and so its content) to `type`. */
  is<K extends KnownEventType>(type: K): this is MatrixEvent<K> {
    return (this.type as string) === type;
  }

  setDecrypted(clear: { type: string; content: Record<string, unknown> }, info: DecryptionInfo): void {
    this.clear = clear;
    this.decryptionStatus = "decrypted";
    this.decryptionError = undefined;
    this.decryptionInfo = info;
  }

  setDecryptionFailed(code: DecryptionFailureCode): void {
    this.decryptionStatus = "failed";
    this.decryptionError = code;
  }

  /** Apply a redaction: content is reduced as the redaction algorithm does for the event's keys. */
  applyRedaction(redaction: ClientEvent): void {
    this.redactedBy = redaction.event_id;
    this.clear = undefined;
    this.wire = {
      ...this.wire,
      content: redactContent(this.wire.type, this.wire.content as Record<string, unknown>) as never,
      unsigned: { ...this.wire.unsigned, redacted_because: redaction },
    };
  }

  toJSON(): ClientEvent {
    return this.wire;
  }
}

/**
 * The content keys a redaction keeps, per room version 11's rules
 * (https://spec.matrix.org/v1.16/rooms/v11/#redactions). For older room versions the server
 * redacts authoritatively anyway; this is only the client's local view until it syncs the
 * redacted event, so the newest rules are used for all versions.
 */
const KEPT_CONTENT_KEYS: Record<string, string[]> = {
  "m.room.member": ["membership", "join_authorised_via_users_server", "third_party_invite"],
  "m.room.create": [],
  "m.room.join_rules": ["join_rule", "allow"],
  "m.room.power_levels": ["ban", "events", "events_default", "invite", "kick", "redact", "state_default", "users", "users_default"],
  "m.room.history_visibility": ["history_visibility"],
};

export function redactContent(type: string, content: Record<string, unknown>): Record<string, unknown> {
  if (type === "m.room.create") return { ...content };
  const keep = KEPT_CONTENT_KEYS[type] ?? [];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (k in content) out[k] = content[k];
  return out;
}
