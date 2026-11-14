import { Homeserver } from "../homeserver.js";
import { KeyObject } from "node:crypto";
/**
 * Remote server signing keys. Keys are fetched directly from the server
 * (`/_matrix/key/v2/server`), verified against their self-signature, cached in
 * memory and persisted in the database.
 */
export declare class KeyRing {
  private hs;
  private cache;
  private inflight;
  constructor(hs: Homeserver);
  /** Get a verify key, fetching the server's keys when unknown or expired (as of `minValidUntil`). */
  getKey(serverName: string, keyId: string, minValidUntil?: number): Promise<KeyObject | null>;
  private remember;
  private fetchKeys;
  private doFetch;
  /** Validate and store a `/_matrix/key/v2/server` response; resolves whether it was accepted. */
  ingestServerKeys(serverName: string, body: Record<string, unknown>): Promise<boolean>;
  /** Verify that `obj` carries a valid signature from `serverName`. */
  verifySignedBy(obj: object, serverName: string, minValidUntil?: number): Promise<boolean>;
  /** Cached keys in `/_matrix/key/v2/query` format (we act as a basic notary for keys we know). */
  knownKeys(serverName: string): Promise<{
    server_name: string;
    valid_until_ts: number;
    verify_keys: Record<string, {
      key: string;
    }>;
    old_verify_keys: {};
  }[]>;
}
//# sourceMappingURL=keyring.d.ts.map