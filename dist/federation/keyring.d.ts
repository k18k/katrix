import { type KeyObject } from "node:crypto";
import type { Homeserver } from "#homeserver.ts";
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
    /** Validate and store a `/_matrix/key/v2/server` response. */
    ingestServerKeys(serverName: string, body: Record<string, any>): Promise<void>;
    /** Verify that `obj` carries a valid signature from `serverName`. */
    verifySignedBy(obj: Record<string, any>, serverName: string, minValidUntil?: number): Promise<boolean>;
    /** Cached keys in `/_matrix/key/v2/query` format (we act as a basic notary for keys we know). */
    knownKeys(serverName: string): Promise<Record<string, any>[]>;
}
