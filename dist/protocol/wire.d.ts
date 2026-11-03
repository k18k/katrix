/**
 * The protobuf-like encoding of Olm and Megolm messages: a tag byte (field number << 3 | type,
 * type 0 = varint, 2 = length-prefixed bytes), then the value. Fields may come in any order and
 * unknown fields are skipped, as libolm and vodozemac do; a field that repeats keeps its last
 * value. Truncated input and integers that do not fit in 32 bits are errors.
 */
export declare function encodeVarint(n: number): number[];
export declare class WireWriter {
    private parts;
    byte(b: number): this;
    varintField(tag: number, value: number): this;
    bytesField(tag: number, value: Uint8Array): this;
    finish(): Uint8Array;
}
export type WireFields = Map<number, number | Uint8Array>;
/** Reads the fields of `bytes` (after the version byte), keyed by tag byte. */
export declare function readFields(bytes: Uint8Array): WireFields;
export declare function bytesField(fields: WireFields, tag: number, length?: number): Uint8Array | undefined;
export declare function intField(fields: WireFields, tag: number): number | undefined;
