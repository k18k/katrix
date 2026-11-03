/**
 * A room event. For an encrypted event, `type` and `content` are the decrypted ones once it is
 * decrypted; `wire` keeps what the server sent.
 */
export class MatrixEvent {
    wire;
    clear;
    decryptionStatus = "none";
    decryptionError;
    decryptionInfo;
    /** For our own events while they are sent. */
    localStatus;
    txnId;
    /** Set when a redaction for this event arrived. */
    redactedBy;
    constructor(wire) {
        this.wire = wire;
        if (wire.type === "m.room.encrypted")
            this.decryptionStatus = "pending";
    }
    get eventId() {
        return this.wire.event_id;
    }
    get type() {
        return (this.clear?.type ?? this.wire.type);
    }
    get content() {
        return (this.clear?.content ?? this.wire.content);
    }
    get sender() {
        return this.wire.sender;
    }
    get roomId() {
        return this.wire.room_id;
    }
    get stateKey() {
        return this.wire.state_key;
    }
    get originServerTs() {
        return this.wire.origin_server_ts;
    }
    get unsigned() {
        return this.wire.unsigned ?? {};
    }
    isState() {
        return this.wire.state_key !== undefined;
    }
    /** Whether the event was sent encrypted (whatever its decryption state). */
    isEncrypted() {
        return this.wire.type === "m.room.encrypted";
    }
    isRedacted() {
        return this.redactedBy !== undefined || this.wire.unsigned?.redacted_because !== undefined;
    }
    /** Narrows the event's type (and so its content) to `type`. */
    is(type) {
        return this.type === type;
    }
    setDecrypted(clear, info) {
        this.clear = clear;
        this.decryptionStatus = "decrypted";
        this.decryptionError = undefined;
        this.decryptionInfo = info;
    }
    setDecryptionFailed(code) {
        this.decryptionStatus = "failed";
        this.decryptionError = code;
    }
    /** Apply a redaction: content is reduced as the redaction algorithm does for the event's keys. */
    applyRedaction(redaction) {
        this.redactedBy = redaction.event_id;
        this.clear = undefined;
        this.wire = {
            ...this.wire,
            content: redactContent(this.wire.type, this.wire.content),
            unsigned: { ...this.wire.unsigned, redacted_because: redaction },
        };
    }
    toJSON() {
        return this.wire;
    }
}
/**
 * The content keys a redaction keeps, per room version 11's rules
 * (https://spec.matrix.org/v1.16/rooms/v11/#redactions). For older room versions the server
 * redacts authoritatively anyway; this is only the client's local view until it syncs the
 * redacted event, so the newest rules are used for all versions.
 */
const KEPT_CONTENT_KEYS = {
    "m.room.member": ["membership", "join_authorised_via_users_server", "third_party_invite"],
    "m.room.create": [],
    "m.room.join_rules": ["join_rule", "allow"],
    "m.room.power_levels": ["ban", "events", "events_default", "invite", "kick", "redact", "state_default", "users", "users_default"],
    "m.room.history_visibility": ["history_visibility"],
};
export function redactContent(type, content) {
    if (type === "m.room.create")
        return { ...content };
    const keep = KEPT_CONTENT_KEYS[type] ?? [];
    const out = {};
    for (const k of keep)
        if (k in content)
            out[k] = content[k];
    return out;
}
