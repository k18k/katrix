import type { E2EEProtocol } from "../protocol/protocol.ts";
import type { Store } from "../storage/store.ts";
import { describeError, type Logger } from "../util/logger.ts";
import { sleep } from "../platform.ts";
import type { ToDeviceEvent } from "@katrix/shared";
import { inboundKey, type DeviceInfo, type InboundGroupSessionRecord, type Pickler } from "./crypto-store.ts";
import type { CrossSigning } from "./cross-signing.ts";
import type { DeviceTracker } from "./devices.ts";
import { MEGOLM_ALGORITHM } from "./keys.ts";
import type { DecryptedToDevice, OlmService } from "./olm.ts";

/** A secret this device can give to the user's other verified devices, by name. */
export type SecretProvider = (name: string) => Promise<string | undefined>;

interface PendingSecret {
  name: string;
  resolve: (secret: string | undefined) => void;
  devices: DeviceInfo[];
}

/** Requests for one session at most this often (keys may simply not exist anywhere). */
const KEY_REQUEST_INTERVAL_MS = 15 * 60_000;

/**
 * Sharing keys and secrets between the user's own devices
 * (https://spec.matrix.org/v1.19/client-server-api/#key-requests and #sharing): room key
 * requests and m.forwarded_room_key, m.secret.request and m.secret.send, and the
 * m.room_key.withheld notices that say why a key will not come.
 *
 * Only the user's own verified devices are answered, and only answers from them, to requests
 * this device sent, are accepted: a server, or another user, cannot get keys or plant them.
 */
export class KeySharing {
  private readonly store: Store;
  private readonly pickler: Pickler;
  private readonly protocol: E2EEProtocol;
  private readonly olm: OlmService;
  private readonly devices: DeviceTracker;
  private readonly crossSigning: CrossSigning;
  private readonly logger: Logger;
  private readonly userId: string;
  private readonly deviceId: string;
  private readonly txnId: () => string;
  private readonly sendPlain: (type: string, messages: Record<string, Record<string, Record<string, unknown>>>) => Promise<void>;
  private readonly secrets = new Map<string, PendingSecret>();
  secretProvider?: SecretProvider;

  constructor(opts: {
    store: Store;
    pickler: Pickler;
    protocol: E2EEProtocol;
    olm: OlmService;
    devices: DeviceTracker;
    crossSigning: CrossSigning;
    logger: Logger;
    userId: string;
    deviceId: string;
    txnId: () => string;
    sendPlain: (type: string, messages: Record<string, Record<string, Record<string, unknown>>>) => Promise<void>;
  }) {
    this.store = opts.store;
    this.pickler = opts.pickler;
    this.protocol = opts.protocol;
    this.olm = opts.olm;
    this.devices = opts.devices;
    this.crossSigning = opts.crossSigning;
    this.logger = opts.logger;
    this.userId = opts.userId;
    this.deviceId = opts.deviceId;
    this.txnId = opts.txnId;
    this.sendPlain = opts.sendPlain;
  }

  private async verifiedOwnDevices(): Promise<DeviceInfo[]> {
    await this.devices.refresh([this.userId]);
    const out: DeviceInfo[] = [];
    for (const d of await this.devices.devices(this.userId))
      if (d.deviceId !== this.deviceId && (await this.crossSigning.deviceTrust(this.userId, d.deviceId)).verified) out.push(d);
    return out;
  }

  private async isVerifiedOwnDevice(senderKey: string): Promise<DeviceInfo | undefined> {
    const device = await this.devices.deviceByCurveKey(this.userId, senderKey);
    if (!device || device.deviceId === this.deviceId) return undefined;
    return (await this.crossSigning.deviceTrust(this.userId, device.deviceId)).verified ? device : undefined;
  }

  // ─── Room keys ────────────────────────────────────────────────────────────

  /** Ask the user's other devices for a room key this device lacks (at most every 15 minutes per session). */
  async requestRoomKey(roomId: string, sessionId: string, senderKey?: string): Promise<void> {
    const key = `keyreq|${roomId}|${sessionId}`;
    const last = await this.store.get<{ requestId: string; at: number }>("client", key);
    if (last && Date.now() - last.at < KEY_REQUEST_INTERVAL_MS) return;
    const requestId = this.txnId();
    await this.store.transaction(async (tx) => tx.put("client", key, { requestId, at: Date.now() }));
    await this.sendPlain("m.room_key_request", {
      [this.userId]: {
        "*": {
          action: "request",
          body: { algorithm: MEGOLM_ALGORITHM, room_id: roomId, session_id: sessionId, ...(senderKey ? { sender_key: senderKey } : {}) },
          request_id: requestId,
          requesting_device_id: this.deviceId,
        },
      },
    });
  }

  /** An m.room_key_request from another device: answered with the key if it is ours and verified. */
  async handleRoomKeyRequest(event: ToDeviceEvent): Promise<void> {
    const c = event.content;
    if (event.sender !== this.userId || c.action !== "request" || c.requesting_device_id === this.deviceId) return;
    const body = c.body as { algorithm?: string; room_id?: string; session_id?: string } | undefined;
    if (body?.algorithm !== MEGOLM_ALGORITHM || typeof body.room_id !== "string" || typeof body.session_id !== "string") return;
    const device = (await this.devices.getUser(this.userId))?.devices[c.requesting_device_id as string];
    if (!device || !(await this.crossSigning.deviceTrust(this.userId, device.deviceId)).verified) {
      this.logger.info("not sharing a room key with an unverified device", { deviceId: c.requesting_device_id });
      return;
    }
    const record = await this.store.get<InboundGroupSessionRecord>("inbound_group_sessions", inboundKey(body.room_id, body.session_id));
    if (!record) return;
    const session = this.pickler.inbound(record);
    const exported = session.exportAt(session.firstKnownIndex());
    if (!exported) return;
    const content = {
      algorithm: MEGOLM_ALGORITHM,
      room_id: record.roomId,
      session_id: record.sessionId,
      session_key: exported,
      sender_key: record.senderKey,
      sender_claimed_ed25519_key: record.claimedEd25519Key ?? "",
      forwarding_curve25519_key_chain: record.forwardingChain ?? [],
    };
    await this.olm.ensureSessions([device]);
    const messages: Array<{ device: DeviceInfo; content: Record<string, unknown> }> = [];
    await this.store.transaction(async (tx) => {
      const enc = await this.olm.encrypt(tx, device, "m.forwarded_room_key", content);
      if (enc) messages.push({ device, content: enc });
    });
    await this.olm.sendToDevice("m.room.encrypted", messages, this.txnId);
  }

  /**
   * An m.forwarded_room_key (decrypted over Olm): stored only if it comes from a verified device
   * of ours and answers a request this device made. Returns the session if it was stored.
   */
  async handleForwardedRoomKey(decrypted: DecryptedToDevice): Promise<{ roomId: string; sessionId: string } | undefined> {
    const c = decrypted.content;
    if (decrypted.sender !== this.userId || !(await this.isVerifiedOwnDevice(decrypted.senderKey))) {
      this.logger.warn("ignoring a forwarded room key from a device that is not ours and verified", { sender: decrypted.sender });
      return undefined;
    }
    if (
      c.algorithm !== MEGOLM_ALGORITHM ||
      typeof c.room_id !== "string" ||
      typeof c.session_id !== "string" ||
      typeof c.session_key !== "string"
    )
      return undefined;
    const requested = await this.store.get("client", `keyreq|${c.room_id}|${c.session_id}`);
    if (!requested) {
      this.logger.warn("ignoring a forwarded room key nobody asked for", { roomId: c.room_id });
      return undefined;
    }
    let session;
    try {
      session = this.protocol.inboundGroupSessionFromExport(c.session_key);
    } catch (e) {
      this.logger.warn("ignoring a malformed forwarded room key", describeError(e));
      return undefined;
    }
    if (session.sessionId() !== c.session_id) return undefined;
    const stored = await this.store.transaction(async (tx) => {
      const key = inboundKey(c.room_id, c.session_id);
      const existing = await tx.get<InboundGroupSessionRecord>("inbound_group_sessions", key);
      if (existing && session.compare(this.pickler.inbound(existing)) !== "better") return false;
      tx.put("inbound_group_sessions", key, {
        pickle: this.pickler.pickle(session),
        roomId: c.room_id,
        sessionId: c.session_id,
        senderKey: typeof c.sender_key === "string" ? c.sender_key : "",
        senderUserId: existing?.senderUserId ?? "",
        claimedEd25519Key: typeof c.sender_claimed_ed25519_key === "string" ? c.sender_claimed_ed25519_key : undefined,
        firstKnownIndex: session.firstKnownIndex(),
        source: "forwarded",
        forwardingChain: [
          ...(Array.isArray(c.forwarding_curve25519_key_chain) ? c.forwarding_curve25519_key_chain : []),
          decrypted.senderKey,
        ],
      } satisfies InboundGroupSessionRecord);
      tx.delete("client", `keyreq|${c.room_id}|${c.session_id}`);
      return true;
    });
    if (!stored) return undefined;
    // The others need not answer any more.
    const req = requested as { requestId: string };
    await this.sendPlain("m.room_key_request", {
      [this.userId]: { "*": { action: "request_cancellation", request_id: req.requestId, requesting_device_id: this.deviceId } },
    }).catch((e) => this.logger.warn("could not cancel a room key request", describeError(e)));
    return { roomId: c.room_id, sessionId: c.session_id };
  }

  /** m.room_key.withheld: the sender will not share the key, and says why (shown on the undecryptable events). */
  async handleWithheld(event: ToDeviceEvent): Promise<void> {
    const c = event.content;
    if (typeof c.room_id !== "string" || typeof c.session_id !== "string" || typeof c.code !== "string") return;
    await this.store.transaction(async (tx) =>
      tx.put("client", `withheld|${c.room_id}|${c.session_id}`, {
        code: c.code,
        reason: typeof c.reason === "string" ? c.reason : undefined,
        sender: event.sender,
      }),
    );
  }

  async withheld(roomId: string, sessionId: string): Promise<{ code: string; reason?: string } | undefined> {
    return this.store.get("client", `withheld|${roomId}|${sessionId}`);
  }

  // ─── Secrets ──────────────────────────────────────────────────────────────

  /**
   * Ask the user's other verified devices for a secret (m.cross_signing.self_signing,
   * m.megolm_backup.v1, …). Resolves with the first answer from one of them, or undefined after
   * `timeoutMs`.
   */
  async requestSecret(name: string, timeoutMs = 30_000): Promise<string | undefined> {
    const devices = await this.verifiedOwnDevices();
    if (devices.length === 0) return undefined;
    const requestId = this.txnId();
    const result = new Promise<string | undefined>((resolve) => this.secrets.set(requestId, { name, resolve, devices }));
    await this.sendPlain("m.secret.request", {
      [this.userId]: Object.fromEntries(
        devices.map((d) => [d.deviceId, { name, action: "request", requesting_device_id: this.deviceId, request_id: requestId }]),
      ),
    });
    const timeout = sleep(timeoutMs).then(() => undefined);
    const secret = await Promise.race([result, timeout]);
    this.secrets.delete(requestId);
    // Cancel at the devices that did not answer (all of them, after a timeout).
    await this.sendPlain("m.secret.request", {
      [this.userId]: Object.fromEntries(
        devices.map((d) => [d.deviceId, { action: "request_cancellation", requesting_device_id: this.deviceId, request_id: requestId }]),
      ),
    }).catch(() => {});
    return secret;
  }

  /** An m.secret.request from another device of ours: answered over Olm if it is verified and we have the secret. */
  async handleSecretRequest(event: ToDeviceEvent): Promise<void> {
    const c = event.content;
    if (event.sender !== this.userId || c.action !== "request" || typeof c.name !== "string" || c.requesting_device_id === this.deviceId)
      return;
    const device = (await this.devices.getUser(this.userId))?.devices[c.requesting_device_id as string];
    if (!device || !(await this.crossSigning.deviceTrust(this.userId, device.deviceId)).verified) {
      this.logger.info("not sharing a secret with an unverified device", { deviceId: c.requesting_device_id });
      return;
    }
    const secret = await this.secretProvider?.(c.name);
    if (secret === undefined) return;
    await this.olm.ensureSessions([device]);
    const messages: Array<{ device: DeviceInfo; content: Record<string, unknown> }> = [];
    await this.store.transaction(async (tx) => {
      const enc = await this.olm.encrypt(tx, device, "m.secret.send", { request_id: c.request_id, secret });
      if (enc) messages.push({ device, content: enc });
    });
    await this.olm.sendToDevice("m.room.encrypted", messages, this.txnId);
  }

  /** An m.secret.send (decrypted over Olm): accepted only from a device we asked, of ours and verified. */
  async handleSecretSend(decrypted: DecryptedToDevice): Promise<void> {
    const c = decrypted.content;
    const pending = typeof c.request_id === "string" ? this.secrets.get(c.request_id) : undefined;
    if (!pending || decrypted.sender !== this.userId || typeof c.secret !== "string") return;
    if (!pending.devices.some((d) => d.curve25519 === decrypted.senderKey) || !(await this.isVerifiedOwnDevice(decrypted.senderKey))) {
      this.logger.warn("ignoring a secret from a device it was not asked of");
      return;
    }
    pending.resolve(c.secret);
  }
}
