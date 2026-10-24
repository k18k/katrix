import type { CryptoPrimitives } from "../crypto/primitives.ts";
import { decodeBase64, encodeBase64 } from "../util/base64.ts";
import { concatBytes, constantTimeEqual } from "../util/bytes.ts";
import { decodeUtf8, encodeUtf8 } from "../util/utf8.ts";
import { ProtocolError, type PickleKey } from "./protocol.ts";

/**
 * Pickles of the built-in protocol: JSON with bytes as unpadded Base64, tagged with a format and
 * object kind. With a pickle key, the JSON is encrypted and authenticated:
 *
 *   "e1:" || Base64( iv(16) || AES-256-CTR(ciphertext) || HMAC-SHA-256(iv || ciphertext) )
 *
 * with the AES and HMAC keys from HKDF-SHA-256(pickle key, info "MNC_PICKLE_V1"), and a fresh
 * random IV per pickle (CTR with a repeated IV would leak the XOR of two states). The MAC is
 * checked before anything is decrypted. A pickle written without a key is refused when a key is
 * given, so a store cannot be downgraded to plaintext state unnoticed.
 *
 * This format is not libolm's or vodozemac's: pickles stay inside one implementation (the
 * E2EEProtocol id is stored next to them). Moving state between implementations goes through
 * the exchange formats (session export), not pickles.
 */

const PICKLE_INFO = encodeUtf8("MNC_PICKLE_V1");
const FORMAT = "mnc-pickle-1";

export type Pickled = Record<string, unknown>;

function keys(p: CryptoPrimitives, key: PickleKey) {
  if (key.length !== 32) throw new ProtocolError("BAD_PICKLE_KEY", "A pickle key must be 32 bytes");
  const okm = p.hkdfSha256(key, undefined, PICKLE_INFO, 64);
  return { aes: okm.slice(0, 32), mac: okm.slice(32) };
}

export function writePickle(p: CryptoPrimitives, kind: string, state: Pickled, key?: PickleKey): string {
  const json = JSON.stringify({ format: FORMAT, kind, ...state });
  if (!key) return json;
  const k = keys(p, key);
  const iv = p.randomBytes(16);
  const ciphertext = p.aes256Ctr(k.aes, iv, encodeUtf8(json));
  const mac = p.hmacSha256(k.mac, concatBytes(iv, ciphertext));
  return "e1:" + encodeBase64(concatBytes(iv, ciphertext, mac));
}

export function readPickle(p: CryptoPrimitives, kind: string, pickle: string, key?: PickleKey): Pickled {
  let json: string;
  if (pickle.startsWith("e1:")) {
    if (!key) throw new ProtocolError("BAD_PICKLE_KEY", "This pickle is encrypted; a pickle key is needed");
    const k = keys(p, key);
    let raw: Uint8Array;
    try {
      raw = decodeBase64(pickle.slice(3));
    } catch {
      throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
    }
    if (raw.length < 16 + 32) throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
    const iv = raw.subarray(0, 16);
    const ciphertext = raw.subarray(16, raw.length - 32);
    const mac = raw.subarray(raw.length - 32);
    if (!constantTimeEqual(mac, p.hmacSha256(k.mac, concatBytes(iv, ciphertext)))) {
      throw new ProtocolError("BAD_PICKLE_KEY", "Wrong pickle key or corrupted pickle");
    }
    json = decodeUtf8(p.aes256Ctr(k.aes, iv, ciphertext));
  } else {
    if (key) throw new ProtocolError("BAD_PICKLE_KEY", "This pickle is not encrypted, but a pickle key was given");
    json = pickle;
  }
  let state: Pickled;
  try {
    state = JSON.parse(json);
  } catch {
    throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
  }
  if (typeof state !== "object" || state === null || state.format !== FORMAT || state.kind !== kind) {
    throw new ProtocolError("BAD_PICKLE", `Not a ${kind} pickle`);
  }
  return state;
}

/** Field readers for unpickling: a missing or malformed field is a corrupted pickle. */
export const field = {
  bytes(state: Pickled, name: string, length?: number): Uint8Array {
    const v = state[name];
    if (typeof v !== "string") throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(v);
    } catch {
      throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
    }
    if (length !== undefined && bytes.length !== length) throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
    return bytes;
  },
  uint(state: Pickled, name: string): number {
    const v = state[name];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
    return v;
  },
  bool(state: Pickled, name: string): boolean {
    const v = state[name];
    if (typeof v !== "boolean") throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
    return v;
  },
  array(state: Pickled, name: string): Pickled[] {
    const v = state[name];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "object" || x === null)) throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
    return v as Pickled[];
  },
  optional(state: Pickled, name: string): Pickled | undefined {
    const v = state[name];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "object") throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
    return v as Pickled;
  },
};

export const b64 = (bytes: Uint8Array) => encodeBase64(bytes);

/** Decode a Base64 key from the wire, as a protocol error (not echoing it) when malformed. */
export function decodeKey(value: string, length: number): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(value);
  } catch {
    throw new ProtocolError("BAD_PUBLIC_KEY", "Malformed key");
  }
  if (bytes.length !== length) throw new ProtocolError("BAD_PUBLIC_KEY", "Malformed key");
  return bytes;
}
