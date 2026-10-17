import {
  DeviceId,
  DeviceLists,
  OlmMachine,
  RoomId,
  UserId,
  type DecryptedRoomEvent,
  type RequestType,
  type StoreType,
} from "@matrix-org/matrix-sdk-crypto-nodejs";

// A small Matrix client with end-to-end encryption (matrix-sdk-crypto, the Rust crypto of the
// Element apps): the audit bot's, and the test's. It talks to the homeserver through a fetch
// function, which for the bot is the homeserver's own handler (same process, no network).

export type Fetch = (request: Request) => Promise<Response>;

/** The request types of matrix-sdk-crypto (a const enum in its typings). */
const Req = { KeysUpload: 0, KeysQuery: 1, KeysClaim: 2, ToDevice: 3, SignatureUpload: 4, RoomMessage: 5, KeysBackup: 6 } as const;

/**
 * matrix-sdk-crypto puts signature uploads under `signed_keys`; the endpoint takes the map of
 * signatures itself as the body.
 */
function signatureUploadBody(body: string): string {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  return Object.keys(parsed).length === 1 && parsed.signed_keys ? JSON.stringify(parsed.signed_keys) : body;
}

export class MatrixError extends Error {
  readonly status: number;
  readonly body: Record<string, any>;

  constructor(status: number, body: Record<string, any>) {
    super(`${status} ${body.errcode ?? ""} ${body.error ?? ""}`.trim());
    this.status = status;
    this.body = body;
  }
}

export class CryptoClient {
  readonly userId: string;
  readonly deviceId: string;
  private accessToken: string;
  private fetch: Fetch;
  private baseUrl: string;
  private txn = 0;
  machine!: OlmMachine;

  constructor(opts: { fetch: Fetch; baseUrl?: string; userId: string; deviceId: string; accessToken: string }) {
    this.fetch = opts.fetch;
    this.baseUrl = opts.baseUrl ?? "http://localhost";
    this.userId = opts.userId;
    this.deviceId = opts.deviceId;
    this.accessToken = opts.accessToken;
  }

  /**
   * Open the crypto store. With `storePath`, keys live in an encrypted SQLite store there (they
   * must survive restarts: room keys are sent once). Without, in memory (tests).
   */
  async open(storePath?: string, passphrase?: string): Promise<void> {
    this.machine = await OlmMachine.initialize(
      new UserId(this.userId),
      new DeviceId(this.deviceId),
      storePath ?? null,
      passphrase ?? null,
      // StoreType.Sqlite (a const enum in the typings, which cannot be read here).
      storePath ? (0 as StoreType) : null,
    );
  }

  async request<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.fetch(
      new Request(`${this.baseUrl}${path}`, {
        method,
        signal,
        headers: { authorization: `Bearer ${this.accessToken}`, "content-type": "application/json" },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new MatrixError(res.status, json);
    return json as T;
  }

  /** Feed a /sync response to the crypto machine, then send what it needs sent. */
  async receiveSync(sync: Record<string, any>): Promise<void> {
    const changed = (sync.device_lists?.changed ?? []).map((u: string) => new UserId(u));
    const left = (sync.device_lists?.left ?? []).map((u: string) => new UserId(u));
    await this.machine.receiveSyncChanges(
      JSON.stringify(sync.to_device?.events ?? []),
      new DeviceLists(changed, left),
      sync.device_one_time_keys_count ?? {},
      sync.device_unused_fallback_key_types ?? [],
    );
    await this.flush();
  }

  /** Send every outgoing request of the crypto machine (key uploads, queries, claims, to-device). */
  async flush(): Promise<void> {
    for (let round = 0; round < 10; round++) {
      const requests = await this.machine.outgoingRequests();
      if (requests.length === 0) return;
      for (const r of requests) {
        let response: unknown;
        switch (r.type as number) {
          case Req.KeysUpload:
            response = await this.request("POST", "/_matrix/client/v3/keys/upload", r.body);
            break;
          case Req.KeysQuery:
            response = await this.request("POST", "/_matrix/client/v3/keys/query", r.body);
            break;
          case Req.KeysClaim:
            response = await this.request("POST", "/_matrix/client/v3/keys/claim", r.body);
            break;
          case Req.SignatureUpload:
            response = await this.request("POST", "/_matrix/client/v3/keys/signatures/upload", signatureUploadBody(r.body));
            break;
          case Req.ToDevice: {
            const t = r as unknown as { eventType: string; txnId: string; body: string };
            response = await this.request(
              "PUT",
              `/_matrix/client/v3/sendToDevice/${encodeURIComponent(t.eventType)}/${encodeURIComponent(t.txnId)}`,
              t.body,
            );
            break;
          }
          case Req.RoomMessage: {
            const m = r as unknown as { roomId: string; eventType: string; txnId: string; body: string };
            response = await this.request(
              "PUT",
              `/_matrix/client/v3/rooms/${encodeURIComponent(m.roomId)}/send/${encodeURIComponent(m.eventType)}/${encodeURIComponent(m.txnId)}`,
              m.body,
            );
            break;
          }
          default:
            continue;
        }
        await this.machine.markRequestAsSent(r.id, r.type as RequestType, JSON.stringify(response));
      }
    }
  }

  /** Make sure the crypto machine knows these users' devices. */
  async track(users: string[]): Promise<void> {
    await this.machine.updateTrackedUsers(users.map((u) => new UserId(u)));
    await this.flush();
  }

  decrypt(event: Record<string, any>, roomId: string): Promise<DecryptedRoomEvent> {
    return this.machine.decryptRoomEvent(JSON.stringify(event), new RoomId(roomId));
  }

  /**
   * Set up cross-signing for this account and sign the device with it, so other users' clients
   * see the device as its owner's (not as an unknown one). Only once: an existing identity is kept.
   */
  async ensureCrossSigning(): Promise<void> {
    const status = await this.machine.crossSigningStatus();
    if (status.hasMaster && status.hasSelfSigning) return;
    const requests = await this.machine.bootstrapCrossSigning(true);
    if (requests.uploadKeysReq) {
      const response = await this.request("POST", "/_matrix/client/v3/keys/upload", requests.uploadKeysReq.body);
      await this.machine.markRequestAsSent(requests.uploadKeysReq.id, requests.uploadKeysReq.type, JSON.stringify(response));
    }
    // A first upload needs no user-interactive authentication.
    await this.request("POST", "/_matrix/client/v3/keys/device_signing/upload", requests.uploadSigningKeysReq);
    const signatures = await this.request(
      "POST",
      "/_matrix/client/v3/keys/signatures/upload",
      signatureUploadBody(requests.uploadSignaturesReq.body),
    );
    await this.machine.markRequestAsSent(requests.uploadSignaturesReq.id, requests.uploadSignaturesReq.type, JSON.stringify(signatures));
  }

  /** Encrypt and send a message (the test's sender; the bot itself sends nothing encrypted). */
  async sendEncrypted(roomId: string, members: string[], content: Record<string, unknown>): Promise<string> {
    const { EncryptionSettings } = await import("@matrix-org/matrix-sdk-crypto-nodejs");
    await this.track(members);
    const users = members.map((u) => new UserId(u));
    const claim = await this.machine.getMissingSessions(users);
    if (claim) {
      const response = await this.request("POST", "/_matrix/client/v3/keys/claim", claim.body);
      await this.machine.markRequestAsSent(claim.id, claim.type, JSON.stringify(response));
    }
    for (const r of await this.machine.shareRoomKey(new RoomId(roomId), users, new EncryptionSettings())) {
      const response = await this.request(
        "PUT",
        `/_matrix/client/v3/sendToDevice/${encodeURIComponent(r.eventType)}/${encodeURIComponent(r.txnId)}`,
        r.body,
      );
      await this.machine.markRequestAsSent(r.id, r.type, JSON.stringify(response));
    }
    const encrypted = await this.machine.encryptRoomEvent(new RoomId(roomId), "m.room.message", JSON.stringify(content));
    const sent = await this.request<{ event_id: string }>(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/e2e${Date.now()}${this.txn++}`,
      encrypted,
    );
    return sent.event_id;
  }

  close(): void {
    this.machine?.close();
  }
}
