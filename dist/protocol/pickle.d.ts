import type { CryptoPrimitives } from "../crypto/primitives.ts";
import { type PickleKey } from "./protocol.ts";
export type Pickled = Record<string, unknown>;
export declare function writePickle(p: CryptoPrimitives, kind: string, state: Pickled, key?: PickleKey): string;
export declare function readPickle(p: CryptoPrimitives, kind: string, pickle: string, key?: PickleKey): Pickled;
/** Field readers for unpickling: a missing or malformed field is a corrupted pickle. */
export declare const field: {
    bytes(state: Pickled, name: string, length?: number): Uint8Array;
    uint(state: Pickled, name: string): number;
    bool(state: Pickled, name: string): boolean;
    array(state: Pickled, name: string): Pickled[];
    optional(state: Pickled, name: string): Pickled | undefined;
};
export declare const b64: (bytes: Uint8Array) => string;
/** Decode a Base64 key from the wire, as a protocol error (not echoing it) when malformed. */
export declare function decodeKey(value: string, length: number): Uint8Array;
