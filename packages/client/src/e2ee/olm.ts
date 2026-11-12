import type { MatrixHttpApi } from "../http/api.ts";
import { decodeUtf8, encodeUtf8, type ToDeviceEvent } from "@katrix/shared";
import { ProtocolError, type OlmMessage } from "../protocol/protocol.ts";
import type { Store, Transaction } from "../storage/store.ts";
import { describeError, type Logger } from "../util/logger.ts";
import { loadAccount, olmSessionKey, saveAccount, type DeviceInfo, type OlmSessionRecord, type Pickler } from "./crypto-store.ts";
import type { DeviceTracker } from "./devices.ts";
import { OLM_ALGORITHM, verifyObject } from "./keys.ts";

/** A decrypted to-device event and what the Olm layer proved about its origin. */
export interface DecryptedToDevice {
  type: string;
  content: Record<string, any>;
  sender: string;
  /** The Curve25519 key of the sending device: authenticated by the Olm session. */
  senderKey: string;
  /** The Ed25519 key the sender claims in the payload (checked against its device if known). */
  claimedEd25519Key: string;
  senderDevice?: DeviceInfo;
}

export type OlmFailure =
  | "NOT_FOR_US"
  | "BAD_FORMAT"
  | "NO_SESSION"
  | "DECRYPT_FAILED"
  | "REPLAYED"
  | "PAYLOAD_MISMATCH"
  | "DEVICE_KEY_MISMATCH";

export class OlmDecryptionError extends Error {
  readonly code: OlmFailure;
  constructor(code: OlmFailure, message: string) {
    super(message);
    this.name = "OlmDecryptionError";
    this.code = code;
  }
}

/**
 * Olm sessions with other devices (m.olm.v1.curve25519-aes-sha2,
 * https://spec.matrix.org/v1.16/client-server-api/#molmv1curve25519-aes-sha2): encrypting
 * to-device payloads, decrypting them, and starting sessions from claimed one-time keys.
 */
export class OlmService {
  private readonly api: MatrixHttpApi;
  private readonly store: Store;
  private readonly pickler: Pickler;
  private readonly devices: DeviceTracker;
  private readonly logger: Logger;
  readonly userId: string;
  readonly deviceId: string;
  private identity?: { curve25519: string; ed25519: string };

  constructor(opts: {
    api: MatrixHttpApi;
    store: Store;
    pickler: Pickler;
    devices: DeviceTracker;
    logger: Logger;
    userId: string;
    deviceId: string;
  }) {
    this.api = opts.api;
    this.store = opts.store;
    this.pickler = opts.pickler;
    this.devices = opts.devices;
    this.logger = opts.logger;
    this.userId = opts.userId;
    this.deviceId = opts.deviceId;
  }

  setIdentity(identity: { curve25519: string; ed25519: string }): void {
    this.identity = identity;
  }

  get identityKeys(): { curve25519: string; ed25519: string } {
    if (!this.identity) throw new Error("The crypto engine is not initialised");
    return this.identity;
  }

  async sessions(tx: Transaction | Store, senderKey: string): Promise<OlmSessionRecord[]> {
    return (await tx.list<OlmSessionRecord>("olm_sessions", `${senderKey}|`)).map(([, r]) => r);
  }

  /**
   * The session to send with: the one we last received on (the spec asks clients to prefer it,
   * as it is the one the other side is sure to have), else the newest.
   */
  private static preferred(records: OlmSessionRecord[]): OlmSessionRecord | undefined {
    return [...records].sort((a, b) => (b.lastReceivedAt ?? 0) - (a.lastReceivedAt ?? 0) || b.createdAt - a.createdAt)[0];
  }

  /**
   * Make sure we have an Olm session with each device, claiming one-time keys for those without.
   * Returns the devices we could not get a session with (no one-time key, invalid signature).
   */
  async ensureSessions(devices: DeviceInfo[], opts: { force?: boolean } = {}): Promise<DeviceInfo[]> {
    const missing: DeviceInfo[] = [];
    for (const d of devices) if (opts.force || (await this.sessions(this.store, d.curve25519)).length === 0) missing.push(d);
    if (missing.length === 0) return [];
    const request: Record<string, Record<string, string>> = {};
    for (const d of missing) (request[d.userId] ??= {})[d.deviceId] = "signed_curve25519";
    const res = await this.api.endpoint(
      "POST /v3/keys/claim",
      {},
      {
        body: { one_time_keys: request, timeout: 10_000 },
      },
    );
    const failed: DeviceInfo[] = [];
    await this.store.transaction(async (tx) => {
      const { record, account } = await loadAccount(tx, this.pickler);
      for (const d of missing) {
        const keys = res.one_time_keys?.[d.userId]?.[d.deviceId];
        const entry = keys && Object.entries(keys).find(([id]) => id.startsWith("signed_curve25519:"));
        // An unsigned key (a bare string) is not acceptable: it could be anyone's.
        const otk = entry && typeof entry[1] === "object" && entry[1] !== null ? entry[1] : undefined;
        // A one-time key must be signed by the device it is for, or the server could make us
        // encrypt to a key of its own.
        if (
          !otk ||
          typeof otk.key !== "string" ||
          !verifyObject(this.pickler.protocol, otk as unknown as Record<string, unknown>, d.userId, d.deviceId, d.ed25519)
        ) {
          if (entry) this.logger.warn("claimed one-time key has no valid signature", { userId: d.userId, deviceId: d.deviceId });
          failed.push(d);
          continue;
        }
        try {
          const session = account.createOutboundSession(d.curve25519, otk.key);
          const sessionId = session.sessionId();
          tx.put("olm_sessions", olmSessionKey(d.curve25519, sessionId), {
            pickle: this.pickler.pickle(session),
            sessionId,
            senderKey: d.curve25519,
            createdAt: Date.now(),
          } satisfies OlmSessionRecord);
        } catch (e) {
          this.logger.warn("could not start an Olm session", { userId: d.userId, deviceId: d.deviceId, ...describeError(e) });
          failed.push(d);
        }
      }
      // Creating outbound sessions does not change the account, but keep it consistent anyway.
      saveAccount(tx, this.pickler, record, account);
    });
    return failed;
  }

  /**
   * Encrypt a to-device payload for `device` (which must have a session: ensureSessions). The
   * payload binds sender and recipient, as the spec requires, so it cannot be redirected.
   */
  async encrypt(
    tx: Transaction,
    device: DeviceInfo,
    type: string,
    content: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const record = OlmService.preferred(await this.sessions(tx, device.curve25519));
    if (!record) return undefined;
    const session = this.pickler.session(record);
    const payload = {
      type,
      content,
      sender: this.userId,
      sender_device: this.deviceId,
      keys: { ed25519: this.identityKeys.ed25519 },
      recipient: device.userId,
      recipient_keys: { ed25519: device.ed25519 },
    };
    const message = session.encrypt(encodeUtf8(JSON.stringify(payload)));
    // Stored in the same batch that later leads to sending: a crash cannot make us send two
    // messages with the same chain key.
    tx.put("olm_sessions", olmSessionKey(device.curve25519, record.sessionId), { ...record, pickle: this.pickler.pickle(session) });
    return { algorithm: OLM_ALGORITHM, sender_key: this.identityKeys.curve25519, ciphertext: { [device.curve25519]: message } };
  }

  /**
   * Decrypt an m.room.encrypted to-device event. A pre-key message that no existing session
   * matches starts a new inbound session (using up our one-time key); one that an existing
   * session matches but that does not decrypt is refused (a replay must not start a second
   * session from a fallback key).
   */
  async decrypt(tx: Transaction, event: ToDeviceEvent): Promise<DecryptedToDevice> {
    const content = event.content ?? {};
    if (content.algorithm !== OLM_ALGORITHM || typeof content.sender_key !== "string" || typeof event.sender !== "string") {
      throw new OlmDecryptionError("BAD_FORMAT", "Not an Olm message");
    }
    const senderKey: string = content.sender_key;
    const message = content.ciphertext?.[this.identityKeys.curve25519] as OlmMessage | undefined;
    if (!message) throw new OlmDecryptionError("NOT_FOR_US", "The message has no ciphertext for this device");
    if ((message.type !== 0 && message.type !== 1) || typeof message.body !== "string")
      throw new OlmDecryptionError("BAD_FORMAT", "Malformed Olm message");

    let plaintext: Uint8Array | undefined;
    let matched = false;
    for (const record of await this.sessions(tx, senderKey)) {
      const session = this.pickler.session(record);
      if (message.type === 0 && !session.sessionMatches(message)) continue;
      matched = matched || message.type === 0;
      try {
        plaintext = session.decrypt(message);
      } catch (e) {
        if (!(e instanceof ProtocolError)) throw e;
        continue;
      }
      tx.put("olm_sessions", olmSessionKey(senderKey, record.sessionId), {
        ...record,
        pickle: this.pickler.pickle(session),
        lastReceivedAt: Date.now(),
      });
      break;
    }
    if (!plaintext) {
      if (message.type === 1) throw new OlmDecryptionError("DECRYPT_FAILED", "No Olm session decrypts the message");
      // The session it belongs to exists and works; only this message is old. Not a reason to
      // start a new session (unwedging): that would let replays make us create sessions at will.
      if (matched) throw new OlmDecryptionError("REPLAYED", "Pre-key message for an existing session does not decrypt (replayed)");
      const { record, account } = await loadAccount(tx, this.pickler);
      try {
        const created = account.createInboundSession(senderKey, message);
        plaintext = created.plaintext;
        const sessionId = created.session.sessionId();
        tx.put("olm_sessions", olmSessionKey(senderKey, sessionId), {
          pickle: this.pickler.pickle(created.session),
          sessionId,
          senderKey,
          createdAt: Date.now(),
          lastReceivedAt: Date.now(),
        } satisfies OlmSessionRecord);
        // The one-time key is now used up: the account is saved with the session, atomically.
        saveAccount(tx, this.pickler, record, account);
      } catch (e) {
        if (!(e instanceof ProtocolError)) throw e;
        throw new OlmDecryptionError("NO_SESSION", `Pre-key message does not start a session (${e.code})`);
      }
    }

    let payload: any;
    try {
      payload = JSON.parse(decodeUtf8(plaintext));
    } catch {
      throw new OlmDecryptionError("BAD_FORMAT", "Olm plaintext is not JSON");
    }
    // https://spec.matrix.org/v1.16/client-server-api/#molmv1curve25519-aes-sha2: the payload must
    // name the event's sender, us as the recipient and our Ed25519 key, or it was redirected.
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.type !== "string" ||
      typeof payload.content !== "object" ||
      payload.content === null
    ) {
      throw new OlmDecryptionError("BAD_FORMAT", "Olm payload has no type or content");
    }
    if (payload.sender !== event.sender) throw new OlmDecryptionError("PAYLOAD_MISMATCH", "Olm payload sender differs from the event's");
    if (payload.recipient !== this.userId) throw new OlmDecryptionError("PAYLOAD_MISMATCH", "Olm payload is for another user");
    if (payload.recipient_keys?.ed25519 !== this.identityKeys.ed25519)
      throw new OlmDecryptionError("PAYLOAD_MISMATCH", "Olm payload is for another device");
    const claimed = payload.keys?.ed25519;
    if (typeof claimed !== "string") throw new OlmDecryptionError("BAD_FORMAT", "Olm payload has no sender keys");

    // If we know the device with this Curve25519 key, its Ed25519 key must be the claimed one,
    // and it must be the sender's device.
    const device = await this.devices.deviceByCurveKey(event.sender, senderKey, tx);
    if (device && device.ed25519 !== claimed)
      throw new OlmDecryptionError("DEVICE_KEY_MISMATCH", "Olm payload claims another Ed25519 key than the sending device's");
    return {
      type: payload.type,
      content: payload.content,
      sender: event.sender,
      senderKey,
      claimedEd25519Key: claimed,
      senderDevice: device,
    };
  }

  /** PUT /sendToDevice, in chunks (large rooms can mean thousands of devices). */
  async sendToDevice(
    type: string,
    messages: Array<{ device: DeviceInfo; content: Record<string, unknown> }>,
    txnId: () => string,
  ): Promise<void> {
    for (let i = 0; i < messages.length; i += 250) {
      const body: Record<string, Record<string, Record<string, unknown>>> = {};
      for (const { device, content } of messages.slice(i, i + 250)) (body[device.userId] ??= {})[device.deviceId] = content;
      await this.api.endpoint(
        "PUT /v3/sendToDevice/:eventType/:txnId",
        { eventType: type, txnId: txnId() },
        {
          body: { messages: body },
        },
      );
    }
  }
}
