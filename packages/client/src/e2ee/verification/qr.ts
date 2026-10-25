import { concatBytes, decodeUtf8, encodeUtf8 } from "@katrix/shared";

// QR code verification (https://spec.matrix.org/v1.19/client-server-api/#qr-code-format): the
// binary segment the code holds. Drawing and scanning the code is the app's part.

export const QR_SHOW = "m.qr_code.show.v1";
export const QR_SCAN = "m.qr_code.scan.v1";
export const RECIPROCATE = "m.reciprocate.v1";

/**
 * 0: verifying another user (keys: our master key, theirs as we see it).
 * 1: self-verification by a device that trusts the master key (our master key, the other device's key).
 * 2: self-verification by a device that does not yet (our device key, the master key as we see it).
 */
export type QrMode = 0 | 1 | 2;

export interface QrData {
  mode: QrMode;
  transactionId: string;
  firstKey: Uint8Array;
  secondKey: Uint8Array;
  secret: Uint8Array;
}

const PREFIX = encodeUtf8("MATRIX");

export function encodeQr(d: QrData): Uint8Array {
  if (d.firstKey.length !== 32 || d.secondKey.length !== 32) throw new Error("QR code keys are 32 bytes");
  const id = encodeUtf8(d.transactionId);
  if (id.length > 0xffff) throw new Error("Transaction ID too long");
  return concatBytes(PREFIX, new Uint8Array([0x02, d.mode, id.length >> 8, id.length & 0xff]), id, d.firstKey, d.secondKey, d.secret);
}

/** Parse a scanned code; throws if it is not a Matrix verification code of version 2. */
export function decodeQr(bytes: Uint8Array): QrData {
  if (bytes.length < 10 || !PREFIX.every((b, i) => bytes[i] === b)) throw new Error("Not a Matrix verification QR code");
  if (bytes[6] !== 0x02) throw new Error("Unsupported QR code version");
  const mode = bytes[7];
  if (mode !== 0 && mode !== 1 && mode !== 2) throw new Error("Unknown QR code mode");
  const len = (bytes[8] << 8) | bytes[9];
  const keysAt = 10 + len;
  // The spec suggests about 8 bytes of secret; fewer would make it too easy to guess.
  if (bytes.length < keysAt + 64 + 8) throw new Error("QR code too short");
  return {
    mode,
    transactionId: decodeUtf8(bytes.subarray(10, keysAt)),
    firstKey: bytes.slice(keysAt, keysAt + 32),
    secondKey: bytes.slice(keysAt + 32, keysAt + 64),
    secret: bytes.slice(keysAt + 64),
  };
}
