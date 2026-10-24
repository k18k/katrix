import { ProtocolError } from "./protocol.ts";

/**
 * The protobuf-like encoding of Olm and Megolm messages: a tag byte (field number << 3 | type,
 * type 0 = varint, 2 = length-prefixed bytes), then the value. Fields may come in any order and
 * unknown fields are skipped, as libolm and vodozemac do; a field that repeats keeps its last
 * value. Truncated input and integers that do not fit in 32 bits are errors.
 */

export function encodeVarint(n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError("varint out of range");
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}

export class WireWriter {
  private parts: number[] = [];

  byte(b: number): this {
    this.parts.push(b);
    return this;
  }

  varintField(tag: number, value: number): this {
    this.parts.push(tag, ...encodeVarint(value));
    return this;
  }

  bytesField(tag: number, value: Uint8Array): this {
    this.parts.push(tag, ...encodeVarint(value.length));
    for (const b of value) this.parts.push(b);
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export type WireFields = Map<number, number | Uint8Array>;

/** Reads the fields of `bytes` (after the version byte), keyed by tag byte. */
export function readFields(bytes: Uint8Array): WireFields {
  const fields: WireFields = new Map();
  let i = 0;
  const varint = (): number => {
    let result = 0,
      shift = 0;
    for (;;) {
      if (i >= bytes.length) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Truncated message");
      const b = bytes[i++];
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
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
      if (value > 0xffffffff) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Integer out of range");
      fields.set(tag, value);
    } else if (type === 2) {
      const length = varint();
      if (i + length > bytes.length) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Truncated message");
      fields.set(tag, bytes.slice(i, i + length));
      i += length;
    } else {
      throw new ProtocolError("BAD_MESSAGE_FORMAT", "Unsupported field type");
    }
  }
  return fields;
}

export function bytesField(fields: WireFields, tag: number, length?: number): Uint8Array | undefined {
  const v = fields.get(tag);
  if (v === undefined) return undefined;
  if (!(v instanceof Uint8Array) || (length !== undefined && v.length !== length)) {
    throw new ProtocolError("BAD_MESSAGE_FORMAT", "Malformed field");
  }
  return v;
}

export function intField(fields: WireFields, tag: number): number | undefined {
  const v = fields.get(tag);
  if (v === undefined) return undefined;
  if (typeof v !== "number") throw new ProtocolError("BAD_MESSAGE_FORMAT", "Malformed field");
  return v;
}
