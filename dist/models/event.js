// src/models/event.ts
/**
* A room event. For an encrypted event, `type` and `content` are the decrypted ones once it is
* decrypted; `wire` keeps what the server sent.
*/
var MatrixEvent = class {
	wire;
	clear;
	decryptionStatus = "none";
	decryptionError;
	decryptionInfo;
	/** For a missing room key: the sender said it will not share it (m.room_key.withheld), and why. */
	withheld;
	/** For our own events while they are sent. */
	localStatus;
	txnId;
	/** Set when a redaction for this event arrived. */
	redactedBy;
	/** The edit shown for this event (the newest valid m.replace), kept up to date by its room. */
	replacement;
	constructor(wire) {
		this.wire = wire;
		if (wire.type === "m.room.encrypted") this.decryptionStatus = "pending";
	}
	get eventId() {
		return this.wire.event_id;
	}
	get type() {
		return this.clear?.type ?? this.wire.type;
	}
	get content() {
		return this.clear?.content ?? this.wire.content;
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
		return this.wire.state_key !== void 0;
	}
	/** Whether the event was sent encrypted (whatever its decryption state). */
	isEncrypted() {
		return this.wire.type === "m.room.encrypted";
	}
	isRedacted() {
		return this.redactedBy !== void 0 || this.wire.unsigned?.redacted_because !== void 0;
	}
	/**
	* The content to show: an edit's `m.new_content` once the event was edited, with the
	* original's `m.relates_to` kept (https://spec.matrix.org/v1.19/client-server-api/#applying-mnew_content).
	*/
	get latestContent() {
		const newContent = this.replacement?.content;
		if (!newContent?.["m.new_content"] || this.isRedacted()) return this.content;
		const { "m.relates_to": _ignored, ...rest } = newContent["m.new_content"];
		const relatesTo = this.content["m.relates_to"];
		return relatesTo === void 0 ? rest : {
			...rest,
			"m.relates_to": relatesTo
		};
	}
	isEdited() {
		return this.replacement !== void 0 && !this.isRedacted();
	}
	/** The event this one replies to (rich replies, https://spec.matrix.org/v1.19/client-server-api/#rich-replies). */
	get replyToEventId() {
		const id = (this.content["m.relates_to"] ?? this.wire.content["m.relates_to"])?.["m.in_reply_to"]?.event_id;
		return typeof id === "string" ? id : void 0;
	}
	/** The thread root this event is in, if it is a thread reply. */
	get threadRootId() {
		const rel = this.content["m.relates_to"] ?? this.wire.content["m.relates_to"];
		return rel?.rel_type === "m.thread" && typeof rel.event_id === "string" ? rel.event_id : void 0;
	}
	/** Narrows the event's type (and so its content) to `type`. */
	is(type) {
		return this.type === type;
	}
	setDecrypted(clear, info) {
		this.clear = clear;
		this.decryptionStatus = "decrypted";
		this.decryptionError = void 0;
		this.decryptionInfo = info;
	}
	setDecryptionFailed(code) {
		this.decryptionStatus = "failed";
		this.decryptionError = code;
	}
	/** Apply a redaction: content is reduced as the redaction algorithm does for the event's keys. */
	applyRedaction(redaction) {
		this.redactedBy = redaction.event_id;
		this.clear = void 0;
		this.wire = {
			...this.wire,
			content: redactContent(this.wire.type, this.wire.content),
			unsigned: {
				...this.wire.unsigned,
				redacted_because: redaction
			}
		};
	}
	toJSON() {
		return this.wire;
	}
};
/**
* The content keys a redaction keeps, per room version 11's rules
* (https://spec.matrix.org/v1.16/rooms/v11/#redactions). For older room versions the server
* redacts authoritatively anyway; this is only the client's local view until it syncs the
* redacted event, so the newest rules are used for all versions.
*/
const KEPT_CONTENT_KEYS = {
	"m.room.member": [
		"membership",
		"join_authorised_via_users_server",
		"third_party_invite"
	],
	"m.room.create": [],
	"m.room.join_rules": ["join_rule", "allow"],
	"m.room.power_levels": [
		"ban",
		"events",
		"events_default",
		"invite",
		"kick",
		"redact",
		"state_default",
		"users",
		"users_default"
	],
	"m.room.history_visibility": ["history_visibility"]
};
function redactContent(type, content) {
	if (type === "m.room.create") return { ...content };
	const keep = KEPT_CONTENT_KEYS[type] ?? [];
	const out = {};
	for (const k of keep) if (k in content) out[k] = content[k];
	return out;
}
export { MatrixEvent, redactContent };

//# sourceMappingURL=event.js.map