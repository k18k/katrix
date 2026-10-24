import { ProtocolError } from "../protocol.ts";
import { bytesField, intField, readFields, WireWriter } from "../wire.ts";

/**
 * The Megolm message (megolm.md, "Message format"):
 *
 *   0x03 | 0x08 message index | 0x12 ciphertext | MAC (8 bytes) | Ed25519 signature (64 bytes)
 *
 * The MAC covers everything before it; the signature covers everything before it, MAC included.
 */

export const VERSION = 0x03;
export const MAC_LENGTH = 8;
export const SIGNATURE_LENGTH = 64;

const T_INDEX = 0x08;
const T_CIPHERTEXT = 0x12;

export function encodeBody(index: number, ciphertext: Uint8Array): Uint8Array {
  return new WireWriter().byte(VERSION).varintField(T_INDEX, index).bytesField(T_CIPHERTEXT, ciphertext).finish();
}

export interface DecodedMegolmMessage {
  index: number;
  ciphertext: Uint8Array;
  /** Bytes covered by the MAC. */
  macInput: Uint8Array;
  mac: Uint8Array;
  /** Bytes covered by the signature. */
  signatureInput: Uint8Array;
  signature: Uint8Array;
}

export function decodeMessage(bytes: Uint8Array): DecodedMegolmMessage {
  if (bytes.length < 1) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Empty message");
  if (bytes[0] !== VERSION) throw new ProtocolError("BAD_MESSAGE_VERSION", "Unsupported Megolm message version");
  if (bytes.length < 1 + MAC_LENGTH + SIGNATURE_LENGTH) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Truncated message");
  const sigAt = bytes.length - SIGNATURE_LENGTH;
  const macAt = sigAt - MAC_LENGTH;
  const fields = readFields(bytes.subarray(1, macAt));
  const index = intField(fields, T_INDEX);
  const ciphertext = bytesField(fields, T_CIPHERTEXT);
  if (index === undefined || !ciphertext) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Missing message fields");
  return {
    index,
    ciphertext,
    macInput: bytes.subarray(0, macAt),
    mac: bytes.slice(macAt, sigAt),
    signatureInput: bytes.subarray(0, sigAt),
    signature: bytes.slice(sigAt),
  };
}
