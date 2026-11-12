import { DecryptedRoomEvent, OlmMachine } from "@matrix-org/matrix-sdk-crypto-nodejs";
export type Fetch = (request: Request) => Promise<Response>;
export declare class CryptoClient {
  readonly userId: string;
  readonly deviceId: string;
  private accessToken;
  private fetch;
  private baseUrl;
  private txn;
  machine: OlmMachine;
  constructor(opts: {
    fetch: Fetch;
    baseUrl?: string;
    userId: string;
    deviceId: string;
    accessToken: string;
  });
  /**
   * Open the crypto store. With `storePath`, keys live in an encrypted SQLite store there (they
   * must survive restarts: room keys are sent once). Without, in memory (tests).
   */
  open(storePath?: string, passphrase?: string): Promise<void>;
  request<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  /** Feed a /sync response to the crypto machine, then send what it needs sent. */
  receiveSync(sync: Record<string, any>): Promise<void>;
  /** Send every outgoing request of the crypto machine (key uploads, queries, claims, to-device). */
  flush(): Promise<void>;
  /** Make sure the crypto machine knows these users' devices. */
  track(users: string[]): Promise<void>;
  decrypt(event: Record<string, any>, roomId: string): Promise<DecryptedRoomEvent>;
  /**
   * Set up cross-signing for this account and sign the device with it, so other users' clients
   * see the device as its owner's (not as an unknown one). Only once: an existing identity is kept.
   */
  ensureCrossSigning(): Promise<void>;
  /** Encrypt and send a message (the test's sender; the bot itself sends nothing encrypted). */
  sendEncrypted(roomId: string, members: string[], content: Record<string, unknown>): Promise<string>;
  close(): void;
}
//# sourceMappingURL=client.d.ts.map