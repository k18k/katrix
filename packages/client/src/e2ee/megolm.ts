import type { MatrixEvent, DecryptionFailureCode, DecryptionInfo } from "../models/event.ts";
import { decodeUtf8, encodeUtf8, type MegolmEncryptedContent } from "@katrix/shared";
import { ProtocolError } from "../protocol/protocol.ts";
import type { Store, Transaction } from "../storage/store.ts";
import { describeError, type Logger } from "../util/logger.ts";
import { KeyedMutex } from "../util/mutex.ts";
import {
  inboundKey,
  type DeviceInfo,
  type InboundGroupSessionRecord,
  type OutboundGroupSessionRecord,
  type Pickler,
} from "./crypto-store.ts";
import type { DeviceTracker } from "./devices.ts";
import { MEGOLM_ALGORITHM } from "./keys.ts";
import type { DecryptedToDevice, OlmService } from "./olm.ts";

/** What the client tells the engine about a room it encrypts for. */
export interface RoomEncryptionInfo {
  roomId: string;
  /** m.room.encryption content. */
  algorithm: string;
  rotationPeriodMs?: number;
  rotationPeriodMsgs?: number;
  historyVisibility: string;
  /** Users whose devices get the key (joined, and invited if history visibility allows). */
  members: string[];
}

/**
 * Defaults of m.room.encryption (https://spec.matrix.org/v1.16/client-server-api/#mroomencryption):
 * a week and 100 messages.
 */
const DEFAULT_ROTATION_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_ROTATION_MSGS = 100;

export class MegolmDecryptionError extends Error {
  readonly code: DecryptionFailureCode;
  constructor(code: DecryptionFailureCode, message: string) {
    super(message);
    this.name = "MegolmDecryptionError";
    this.code = code;
  }
}

/** Megolm in rooms (m.megolm.v1.aes-sha2): our outbound sessions and their sharing, and decryption. */
export class MegolmService {
  private readonly store: Store;
  private readonly pickler: Pickler;
  private readonly olm: OlmService;
  private readonly devices: DeviceTracker;
  private readonly logger: Logger;
  private readonly txnId: () => string;
  private readonly roomLocks = new KeyedMutex();

  constructor(opts: { store: Store; pickler: Pickler; olm: OlmService; devices: DeviceTracker; logger: Logger; txnId: () => string }) {
    this.store = opts.store;
    this.pickler = opts.pickler;
    this.olm = opts.olm;
    this.devices = opts.devices;
    this.logger = opts.logger;
    this.txnId = opts.txnId;
  }

  /** Encrypt an event for a room: rotate the session if due, share it with new devices, encrypt. */
  encrypt(room: RoomEncryptionInfo, type: string, content: Record<string, unknown>): Promise<MegolmEncryptedContent> {
    return this.roomLocks.run(room.roomId, async () => {
      if (room.algorithm !== MEGOLM_ALGORITHM) throw new Error(`Unsupported room encryption algorithm ${room.algorithm}`);
      const targets = await this.targetDevices(room);
      const outbound = await this.prepareSession(room, targets);
      await this.share(room, outbound, targets);
      return this.encryptWith(room, type, content);
    });
  }

  /** Devices to share with: every device with Megolm of every target user, except this one. */
  private async targetDevices(room: RoomEncryptionInfo): Promise<DeviceInfo[]> {
    const users = [...new Set([...room.members, this.olm.userId])];
    await this.store.transaction((tx) => this.devices.track(tx, users));
    await this.devices.refresh(users);
    const out: DeviceInfo[] = [];
    for (const userId of users) {
      if (userId !== this.olm.userId && !room.members.includes(userId)) continue;
      for (const d of await this.devices.devices(userId)) {
        if (d.userId === this.olm.userId && d.deviceId === this.olm.deviceId) continue;
        if (!d.algorithms.includes(MEGOLM_ALGORITHM)) continue;
        out.push(d);
      }
    }
    return out;
  }

  /**
   * The outbound session to use, rotated when: its message or time budget is used up; the room's
   * encryption settings or history visibility changed; or a device that has the key is no longer
   * a target (a member left, a device was removed), as it must not read what follows.
   */
  private async prepareSession(room: RoomEncryptionInfo, targets: DeviceInfo[]): Promise<OutboundGroupSessionRecord> {
    return this.store.transaction(async (tx) => {
      const existing = await tx.get<OutboundGroupSessionRecord>("outbound_group_sessions", room.roomId);
      const settings = {
        algorithm: room.algorithm,
        rotationPeriodMs: room.rotationPeriodMs ?? DEFAULT_ROTATION_MS,
        rotationPeriodMsgs: room.rotationPeriodMsgs ?? DEFAULT_ROTATION_MSGS,
        historyVisibility: room.historyVisibility,
      };
      const current = new Set(targets.map((d) => `${d.userId}|${d.deviceId}|${d.curve25519}`));
      const reason = !existing
        ? "new"
        : existing.messageCount >= settings.rotationPeriodMsgs
          ? "message budget"
          : Date.now() - existing.createdAt >= settings.rotationPeriodMs
            ? "age"
            : JSON.stringify(existing.settings) !== JSON.stringify(settings)
              ? "settings"
              : Object.entries(existing.sharedWith).some(([k, s]) => !current.has(`${k}|${s.curve25519}`))
                ? "device removed"
                : undefined;
      if (!reason) return existing!;
      const session = this.pickler.protocol.newOutboundGroupSession();
      const sessionId = session.sessionId();
      if (existing) this.logger.info("rotating the room's Megolm session", { roomId: room.roomId, reason });
      const record: OutboundGroupSessionRecord = {
        pickle: this.pickler.pickle(session),
        sessionId,
        roomId: room.roomId,
        createdAt: Date.now(),
        messageCount: 0,
        sharedWith: {},
        settings,
      };
      tx.put("outbound_group_sessions", room.roomId, record);
      // Our own inbound copy, so we can decrypt what we send (after a restart, or from history).
      const inbound = this.pickler.protocol.inboundGroupSessionFromSessionKey(session.sessionKey());
      tx.put("inbound_group_sessions", inboundKey(room.roomId, sessionId), {
        pickle: this.pickler.pickle(inbound),
        roomId: room.roomId,
        sessionId,
        senderKey: this.olm.identityKeys.curve25519,
        senderUserId: this.olm.userId,
        claimedEd25519Key: this.olm.identityKeys.ed25519,
        firstKnownIndex: inbound.firstKnownIndex(),
        source: "own",
      } satisfies InboundGroupSessionRecord);
      return record;
    });
  }

  /** Send the session key (at its current index) to every target device that does not have it. */
  private async share(room: RoomEncryptionInfo, record: OutboundGroupSessionRecord, targets: DeviceInfo[]): Promise<void> {
    const pending = targets.filter((d) => {
      const s = record.sharedWith[`${d.userId}|${d.deviceId}`];
      return !s || s.curve25519 !== d.curve25519;
    });
    if (pending.length === 0) return;
    const noSession = new Set((await this.olm.ensureSessions(pending)).map((d) => `${d.userId}|${d.deviceId}`));

    // Encrypt the key for each device and store the advanced Olm sessions before anything is
    // sent (see OlmService.encrypt).
    const messages: Array<{ device: DeviceInfo; content: Record<string, unknown> }> = [];
    let index = 0;
    await this.store.transaction(async (tx) => {
      const current = (await tx.get<OutboundGroupSessionRecord>("outbound_group_sessions", room.roomId))!;
      const session = this.pickler.outbound(current);
      index = session.messageIndex();
      const roomKey = {
        algorithm: MEGOLM_ALGORITHM,
        room_id: room.roomId,
        session_id: session.sessionId(),
        session_key: session.sessionKey(),
      };
      for (const d of pending) {
        if (noSession.has(`${d.userId}|${d.deviceId}`)) continue;
        const content = await this.olm.encrypt(tx, d, "m.room_key", roomKey);
        if (content) messages.push({ device: d, content });
      }
    });
    await this.olm.sendToDevice("m.room.encrypted", messages, this.txnId);

    // Devices without a one-time key are told why they cannot decrypt (and are not asked again
    // for this session): m.room_key.withheld with code m.no_olm, which is sent unencrypted.
    const withheld = pending.filter((d) => noSession.has(`${d.userId}|${d.deviceId}`));
    if (withheld.length > 0) {
      await this.olm
        .sendToDevice(
          "m.room_key.withheld",
          withheld.map((device) => ({
            device,
            content: {
              algorithm: MEGOLM_ALGORITHM,
              room_id: room.roomId,
              session_id: record.sessionId,
              sender_key: this.olm.identityKeys.curve25519,
              code: "m.no_olm",
              reason: "Unable to establish a secure channel.",
            },
          })),
          this.txnId,
        )
        .catch((e) => this.logger.warn("could not send m.room_key.withheld", describeError(e)));
    }

    await this.store.transaction(async (tx) => {
      const current = (await tx.get<OutboundGroupSessionRecord>("outbound_group_sessions", room.roomId))!;
      const sharedWith = { ...current.sharedWith };
      for (const { device } of messages) sharedWith[`${device.userId}|${device.deviceId}`] = { curve25519: device.curve25519, index };
      for (const device of withheld)
        sharedWith[`${device.userId}|${device.deviceId}`] = { curve25519: device.curve25519, withheld: "m.no_olm" };
      tx.put("outbound_group_sessions", room.roomId, { ...current, sharedWith });
    });
  }

  private encryptWith(room: RoomEncryptionInfo, type: string, content: Record<string, unknown>): Promise<MegolmEncryptedContent> {
    return this.store.transaction(async (tx) => {
      const record = (await tx.get<OutboundGroupSessionRecord>("outbound_group_sessions", room.roomId))!;
      const session = this.pickler.outbound(record);
      // Relations stay readable by the server (for aggregations and threads): the spec keeps
      // m.relates_to in the clear content of m.room.encrypted
      // (https://spec.matrix.org/v1.16/client-server-api/#mixing-relations-with-encryption…).
      const { "m.relates_to": relatesTo, ...clearContent } = content as Record<string, unknown> & { "m.relates_to"?: unknown };
      const ciphertext = session.encrypt(encodeUtf8(JSON.stringify({ type, content: clearContent, room_id: room.roomId })));
      tx.put("outbound_group_sessions", room.roomId, {
        ...record,
        pickle: this.pickler.pickle(session),
        messageCount: record.messageCount + 1,
      });
      return {
        algorithm: MEGOLM_ALGORITHM,
        ciphertext,
        session_id: record.sessionId,
        sender_key: this.olm.identityKeys.curve25519,
        device_id: this.olm.deviceId,
        ...(relatesTo !== undefined ? { "m.relates_to": relatesTo as MegolmEncryptedContent["m.relates_to"] } : {}),
      };
    });
  }

  /** Force a new session for the next message in the room (for example after a membership change). */
  async discardSession(roomId: string): Promise<void> {
    await this.roomLocks.run(roomId, () => this.store.transaction(async (tx) => tx.delete("outbound_group_sessions", roomId)));
  }

  /**
   * An m.room_key that arrived over Olm. Returns the session's room and ID if it was stored. The
   * session key's signature is verified by the protocol (the key proves its own origin), and the
   * session ID must be the key's.
   */
  async handleRoomKey(tx: Transaction, decrypted: DecryptedToDevice): Promise<{ roomId: string; sessionId: string } | undefined> {
    const c = decrypted.content;
    if (
      c.algorithm !== MEGOLM_ALGORITHM ||
      typeof c.room_id !== "string" ||
      typeof c.session_id !== "string" ||
      typeof c.session_key !== "string"
    ) {
      this.logger.warn("ignoring a malformed m.room_key", { sender: decrypted.sender });
      return undefined;
    }
    let session;
    try {
      session = this.pickler.protocol.inboundGroupSessionFromSessionKey(c.session_key);
    } catch (e) {
      this.logger.warn("ignoring an m.room_key that does not verify", { sender: decrypted.sender, ...describeError(e) });
      return undefined;
    }
    if (session.sessionId() !== c.session_id) {
      this.logger.warn("ignoring an m.room_key whose session ID is not its key's", { sender: decrypted.sender });
      return undefined;
    }
    const key = inboundKey(c.room_id, c.session_id);
    const existing = await tx.get<InboundGroupSessionRecord>("inbound_group_sessions", key);
    if (existing) {
      // Another device cannot take over a session; the same device may resend it, and only an
      // earlier starting index (more history) replaces what we have.
      // A copy from a backup or another of our devices does not prove its origin; the sending
      // device's own m.room_key replaces it when it reaches as far back.
      const weaker = existing.source === "forwarded" || existing.source === "backup";
      if (existing.senderKey !== decrypted.senderKey || (!weaker && existing.senderUserId !== decrypted.sender)) {
        this.logger.warn("ignoring an m.room_key for a session another device sent", { sender: decrypted.sender, roomId: c.room_id });
        return undefined;
      }
      const order = session.compare(this.pickler.inbound(existing));
      if (order !== "better" && !(weaker && order === "equal")) return undefined;
    }
    tx.put("inbound_group_sessions", key, {
      pickle: this.pickler.pickle(session),
      roomId: c.room_id,
      sessionId: c.session_id,
      senderKey: decrypted.senderKey,
      senderUserId: decrypted.sender,
      claimedEd25519Key: decrypted.claimedEd25519Key,
      firstKnownIndex: session.firstKnownIndex(),
      source: "m.room_key",
    } satisfies InboundGroupSessionRecord);
    return { roomId: c.room_id, sessionId: c.session_id };
  }

  /**
   * Decrypt a room event. Checks, beyond the protocol's MAC and signature: the plaintext names the
   * event's room; the session belongs to the event's sender; and no other event used the same
   * message index of the session before (a replay). Throws MegolmDecryptionError.
   */
  async decrypt(event: MatrixEvent): Promise<{ clear: { type: string; content: Record<string, unknown> }; info: DecryptionInfo }> {
    const content = event.wire.content as Partial<MegolmEncryptedContent>;
    const roomId = event.roomId;
    if (content.algorithm !== MEGOLM_ALGORITHM) throw new MegolmDecryptionError("UNKNOWN_ALGORITHM", "Not a Megolm event");
    if (typeof content.ciphertext !== "string" || typeof content.session_id !== "string" || !roomId || !event.sender) {
      throw new MegolmDecryptionError("BAD_ENCRYPTED_MESSAGE", "Malformed Megolm event");
    }
    return this.store.transaction(async (tx) => {
      const record = await tx.get<InboundGroupSessionRecord>("inbound_group_sessions", inboundKey(roomId, content.session_id!));
      // sender_key is deprecated (spec v1.3) but, when present, must be the session's.
      if (!record || (content.sender_key !== undefined && content.sender_key !== record.senderKey)) {
        throw new MegolmDecryptionError("MISSING_ROOM_KEY", "No room key for this session");
      }
      let result;
      try {
        result = this.pickler.inbound(record).decrypt(content.ciphertext!);
      } catch (e) {
        if (e instanceof ProtocolError && e.code === "UNKNOWN_MESSAGE_INDEX")
          throw new MegolmDecryptionError("UNKNOWN_MESSAGE_INDEX", "The room key does not reach back to this message");
        if (e instanceof ProtocolError)
          throw new MegolmDecryptionError("BAD_ENCRYPTED_MESSAGE", `The message does not decrypt (${e.code})`);
        throw e;
      }
      // A session from a backup does not say whose it is (senderUserId ""); it is checked against
      // the sender's devices below, and never counts as authenticated.
      if (record.senderUserId !== "" && record.senderUserId !== event.sender)
        throw new MegolmDecryptionError("SENDER_MISMATCH", "The room key belongs to another user than the event's sender");

      // https://spec.matrix.org/v1.16/client-server-api/#mmegolmv1aes-sha2: clients must guard
      // against replays by remembering (session, index) → event; the same event (ID and
      // timestamp) may be decrypted again.
      const indexKey = `${roomId}|${content.session_id}|${result.messageIndex}`;
      const seen = await tx.get<{ eventId?: string; ts?: number }>("megolm_indices", indexKey);
      if (seen && (seen.eventId !== event.eventId || seen.ts !== event.originServerTs)) {
        throw new MegolmDecryptionError("REPLAYED", "This message index was already used by another event");
      }
      if (!seen) tx.put("megolm_indices", indexKey, { eventId: event.eventId, ts: event.originServerTs });

      let payload: any;
      try {
        payload = JSON.parse(decodeUtf8(result.plaintext));
      } catch {
        throw new MegolmDecryptionError("BAD_ENCRYPTED_MESSAGE", "The plaintext is not JSON");
      }
      if (
        typeof payload !== "object" ||
        payload === null ||
        typeof payload.type !== "string" ||
        typeof payload.content !== "object" ||
        payload.content === null
      ) {
        throw new MegolmDecryptionError("BAD_ENCRYPTED_MESSAGE", "The plaintext has no type or content");
      }
      // The room ID in the plaintext stops a server from moving an event into another room.
      if (payload.room_id !== roomId) throw new MegolmDecryptionError("ROOM_MISMATCH", "The plaintext is for another room");

      const clearContent: Record<string, unknown> = { ...payload.content };
      if (clearContent["m.relates_to"] === undefined && content["m.relates_to"] !== undefined)
        clearContent["m.relates_to"] = content["m.relates_to"];

      const device = await this.devices.deviceByCurveKey(record.senderUserId || event.sender!, record.senderKey, tx);
      let authenticity: DecryptionInfo["authenticity"];
      if (record.source === "own") authenticity = "authenticated";
      else if (!device) authenticity = "unknown_device";
      // Forwarded and backed-up keys do not prove which device made the session.
      else if (record.source !== "m.room_key") authenticity = "unauthenticated";
      else authenticity = device.ed25519 === record.claimedEd25519Key ? "authenticated" : "unauthenticated";
      return {
        clear: { type: payload.type, content: clearContent },
        info: {
          senderCurve25519Key: record.senderKey,
          claimedEd25519Key: record.claimedEd25519Key,
          senderDeviceId: record.source === "own" ? this.olm.deviceId : device?.deviceId,
          authenticity,
        },
      };
    });
  }
}
