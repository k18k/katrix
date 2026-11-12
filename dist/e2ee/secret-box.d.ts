import { CryptoPrimitives } from "../crypto/primitives.js";
import { PickleKey } from "../protocol/protocol.js";
/**
 * Secrets this device keeps at rest (cross-signing private keys, the backup key), sealed with the
 * pickle key like the Olm and Megolm pickles: AES-256-CTR and HMAC-SHA-256 under keys derived
 * from it per secret name. Without a pickle key they are stored as they are, and the storage
 * adapter is the only protection, as for the pickles.
 */
export declare class SecretBox {
  private readonly primitives;
  private readonly key?;
  constructor(primitives: CryptoPrimitives, key?: PickleKey);
  private keys;
  seal(name: string, secret: Uint8Array): string;
  /** Throws when the sealed value was made with another pickle key or was changed. */
  open(name: string, sealed: string): Uint8Array;
}
//# sourceMappingURL=secret-box.d.ts.map