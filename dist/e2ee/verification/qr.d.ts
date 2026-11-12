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
export declare function encodeQr(d: QrData): Uint8Array;
/** Parse a scanned code; throws if it is not a Matrix verification code of version 2. */
export declare function decodeQr(bytes: Uint8Array): QrData;
//# sourceMappingURL=qr.d.ts.map