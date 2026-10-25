import { concatBytes } from "@katrix/shared";
import { ProtocolError } from "../protocol.ts";
import { bytesField, intField, readFields, WireWriter } from "../wire.ts";

/**
 * Olm message formats (olm.md, "The Olm Message Format"). Keys are raw 32-byte Curve25519 keys.
 *
 *   normal:  0x03 | 0x0A ratchet key | 0x10 chain index | 0x22 ciphertext | MAC (8 bytes)
 *   pre-key: 0x03 | 0x0A one-time key | 0x12 base key | 0x1A identity key | 0x22 normal message
 */

export const VERSION = 0x03;
export const MAC_LENGTH = 8;

const T_RATCHET_KEY = 0x0a;
const T_CHAIN_INDEX = 0x10;
const T_CIPHERTEXT = 0x22;
const T_ONE_TIME_KEY = 0x0a;
const T_BASE_KEY = 0x12;
const T_IDENTITY_KEY = 0x1a;
const T_MESSAGE = 0x22;

export interface NormalMessage {
  ratchetKey: Uint8Array;
  chainIndex: number;
  ciphertext: Uint8Array;
  /** The bytes the MAC covers (everything before it). */
  authenticated: Uint8Array;
  mac: Uint8Array;
}

/** The normal message without its MAC; the caller appends HMAC(authenticated)[0..8]. */
export function encodeNormalBody(ratchetKey: Uint8Array, chainIndex: number, ciphertext: Uint8Array): Uint8Array {
  return new WireWriter()
    .byte(VERSION)
    .bytesField(T_RATCHET_KEY, ratchetKey)
    .varintField(T_CHAIN_INDEX, chainIndex)
    .bytesField(T_CIPHERTEXT, ciphertext)
    .finish();
}

export function decodeNormal(bytes: Uint8Array): NormalMessage {
  if (bytes.length < 1) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Empty message");
  if (bytes[0] !== VERSION) throw new ProtocolError("BAD_MESSAGE_VERSION", "Unsupported Olm message version");
  if (bytes.length < 1 + MAC_LENGTH) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Truncated message");
  const authenticated = bytes.subarray(0, bytes.length - MAC_LENGTH);
  const fields = readFields(authenticated.subarray(1));
  const ratchetKey = bytesField(fields, T_RATCHET_KEY, 32);
  const chainIndex = intField(fields, T_CHAIN_INDEX);
  const ciphertext = bytesField(fields, T_CIPHERTEXT);
  if (!ratchetKey || chainIndex === undefined || !ciphertext) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Missing message fields");
  return { ratchetKey, chainIndex, ciphertext, authenticated, mac: bytes.slice(bytes.length - MAC_LENGTH) };
}

export interface PreKeyMessage {
  oneTimeKey: Uint8Array;
  baseKey: Uint8Array;
  identityKey?: Uint8Array;
  message: Uint8Array;
}

export function encodePreKey(m: { oneTimeKey: Uint8Array; baseKey: Uint8Array; identityKey: Uint8Array; message: Uint8Array }): Uint8Array {
  return new WireWriter()
    .byte(VERSION)
    .bytesField(T_ONE_TIME_KEY, m.oneTimeKey)
    .bytesField(T_BASE_KEY, m.baseKey)
    .bytesField(T_IDENTITY_KEY, m.identityKey)
    .bytesField(T_MESSAGE, m.message)
    .finish();
}

export function decodePreKey(bytes: Uint8Array): PreKeyMessage {
  if (bytes.length < 1) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Empty message");
  if (bytes[0] !== VERSION) throw new ProtocolError("BAD_MESSAGE_VERSION", "Unsupported Olm message version");
  const fields = readFields(bytes.subarray(1));
  const oneTimeKey = bytesField(fields, T_ONE_TIME_KEY, 32);
  const baseKey = bytesField(fields, T_BASE_KEY, 32);
  const identityKey = bytesField(fields, T_IDENTITY_KEY, 32);
  const message = bytesField(fields, T_MESSAGE);
  if (!oneTimeKey || !baseKey || !message) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Missing pre-key message fields");
  return { oneTimeKey, baseKey, identityKey, message };
}

export function withMac(authenticated: Uint8Array, mac: Uint8Array): Uint8Array {
  return concatBytes(authenticated, mac.subarray(0, MAC_LENGTH));
}
