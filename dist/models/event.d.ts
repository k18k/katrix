import { ClientEvent, ContentOf, KnownEventType, UnsignedData } from "../shared/events.js";
export type DecryptionStatus = "none" | "pending" | "decrypted" | "failed";
/** Why an event could not be decrypted. */
export type DecryptionFailureCode =
/** We do not have the Megolm session (yet: keys may arrive later). */
"MISSING_ROOM_KEY" |
/** We have the session, but not from this message index on. */
"UNKNOWN_MESSAGE_INDEX" |
/** The same session and index was seen with another event: a replay. */
"REPLAYED" |
/** The plaintext is for another room than the event's. */
"ROOM_MISMATCH" |
/** The session belongs to a different user than the event's sender. */
"SENDER_MISMATCH" |
/** Bad MAC, bad signature, malformed message or plaintext. */
"BAD_ENCRYPTED_MESSAGE" | "UNKNOWN_ALGORITHM";
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
export declare class MatrixEvent<T extends string = string> {
  wire: ClientEvent;
  private clear?;
  decryptionStatus: DecryptionStatus;
  decryptionError?: DecryptionFailureCode;
  decryptionInfo?: DecryptionInfo;
  /** For a missing room key: the sender said it will not share it (m.room_key.withheld), and why. */
  withheld?: {
    code: string;
    reason?: string;
  };
  /** For our own events while they are sent. */
  localStatus?: LocalEchoStatus;
  txnId?: string;
  /** Set when a redaction for this event arrived. */
  redactedBy?: string;
  /** The edit shown for this event (the newest valid m.replace), kept up to date by its room. */
  replacement?: MatrixEvent;
  constructor(wire: ClientEvent);
  get eventId(): string | undefined;
  get type(): T;
  get content(): ContentOf<T>;
  get sender(): string | undefined;
  get roomId(): string | undefined;
  get stateKey(): string | undefined;
  get originServerTs(): number | undefined;
  get unsigned(): UnsignedData;
  isState(): boolean;
  /** Whether the event was sent encrypted (whatever its decryption state). */
  isEncrypted(): boolean;
  isRedacted(): boolean;
  /**
   * The content to show: an edit's `m.new_content` once the event was edited, with the
   * original's `m.relates_to` kept (https://spec.matrix.org/v1.19/client-server-api/#applying-mnew_content).
   */
  get latestContent(): ContentOf<T>;
  isEdited(): boolean;
  /** The event this one replies to (rich replies, https://spec.matrix.org/v1.19/client-server-api/#rich-replies). */
  get replyToEventId(): string | undefined;
  /** The thread root this event is in, if it is a thread reply. */
  get threadRootId(): string | undefined;
  /** Narrows the event's type (and so its content) to `type`. */
  is<K extends KnownEventType>(type: K): this is MatrixEvent<K>;
  setDecrypted(clear: {
    type: string;
    content: Record<string, unknown>;
  }, info: DecryptionInfo): void;
  setDecryptionFailed(code: DecryptionFailureCode): void;
  /** Apply a redaction: content is reduced as the redaction algorithm does for the event's keys. */
  applyRedaction(redaction: ClientEvent): void;
  toJSON(): ClientEvent<string>;
}
export declare function redactContent(type: string, content: Record<string, unknown>): Record<string, unknown>;
//# sourceMappingURL=event.d.ts.map