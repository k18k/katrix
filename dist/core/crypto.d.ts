import { KeyObject } from "node:crypto";
export interface SigningKey {
  keyId: string;
  privateKey: KeyObject;
  publicKeyBase64: string;
  /** Unpadded base64 of the 32-byte ed25519 seed, for persistence. */
  seed: string;
}
//# sourceMappingURL=crypto.d.ts.map