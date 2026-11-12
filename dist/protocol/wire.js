import { ProtocolError } from "./protocol.js";
// src/protocol/wire.ts
/**
* The protobuf-like encoding of Olm and Megolm messages: a tag byte (field number << 3 | type,
* type 0 = varint, 2 = length-prefixed bytes), then the value. Fields may come in any order and
* unknown fields are skipped, as libolm and vodozemac do; a field that repeats keeps its last
* value. Truncated input and integers that do not fit in 32 bits are errors.
*/
function encodeVarint(n) {
	if (!Number.isInteger(n) || n < 0 || n > 4294967295) throw new RangeError("varint out of range");
	const out = [];
	while (n >= 128) {
		out.push(n % 128 | 128);
		n = Math.floor(n / 128);
	}
	out.push(n);
	return out;
}
var WireWriter = class {
	parts = [];
	byte(b) {
		this.parts.push(b);
		return this;
	}
	varintField(tag, value) {
		this.parts.push(tag, ...encodeVarint(value));
		return this;
	}
	bytesField(tag, value) {
		this.parts.push(tag, ...encodeVarint(value.length));
		for (const b of value) this.parts.push(b);
		return this;
	}
	finish() {
		return Uint8Array.from(this.parts);
	}
};
/** Reads the fields of `bytes` (after the version byte), keyed by tag byte. */
function readFields(bytes) {
	const fields = /* @__PURE__ */ new Map();
	let i = 0;
	const varint = () => {
		let result = 0, shift = 0;
		for (;;) {
			if (i >= bytes.length) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Truncated message");
			const b = bytes[i++];
			result += (b & 127) * 2 ** shift;
			if (!(b & 128)) break;
			shift += 7;
			if (shift > 63) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Varint too long");
		}
		return result;
	};
	while (i < bytes.length) {
		const tag = varint();
		const type = tag & 7;
		if (type === 0) {
			const value = varint();
			if (value > 4294967295) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Integer out of range");
			fields.set(tag, value);
		} else if (type === 2) {
			const length = varint();
			if (i + length > bytes.length) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Truncated message");
			fields.set(tag, bytes.slice(i, i + length));
			i += length;
		} else throw new ProtocolError("BAD_MESSAGE_FORMAT", "Unsupported field type");
	}
	return fields;
}
function bytesField(fields, tag, length) {
	const v = fields.get(tag);
	if (v === void 0) return void 0;
	if (!(v instanceof Uint8Array) || length !== void 0 && v.length !== length) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Malformed field");
	return v;
}
function intField(fields, tag) {
	const v = fields.get(tag);
	if (v === void 0) return void 0;
	if (typeof v !== "number") throw new ProtocolError("BAD_MESSAGE_FORMAT", "Malformed field");
	return v;
}
export { WireWriter, bytesField, encodeVarint, intField, readFields };

//# sourceMappingURL=wire.js.map