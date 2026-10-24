import type { MatrixHttpApi } from "../http/api.ts";
import type { MatrixEvent } from "../models/event.ts";
import type { MegolmEncryptedContent, ToDeviceEvent } from "../models/types.ts";
import type { E2EEProtocol, PickleKey } from "../protocol/protocol.ts";
import type { Store, Transaction } from "../storage/store.ts";
import type { SyncResult } from "../sync/types.ts";
import { describeError, type Logger } from "../util/logger.ts";
import { Mutex } from "../util/mutex.ts";
import { loadAccount, Pickler, saveAccount, type AccountRecord, type DeviceInfo } from "./crypto-store.ts";
import { DeviceTracker } from "./devices.ts";
import { deviceKeysObject, oneTimeKeysObject } from "./keys.ts";
import { MegolmDecryptionError, MegolmService, type RoomEncryptionInfo } from "./megolm.ts";
import { OlmDecryptionError, OlmService, type DecryptedToDevice } from "./olm.ts";

export interface E2EEOptions {
  api: MatrixHttpApi;
  store: Store;
  protocol: E2EEProtocol;
  pickleKey?: PickleKey;
  logger: Logger;
  userId: string;
  deviceId: string;
  txnId: () => string;
}

/** What processing a sync's to-device messages produced, for the client to act on after commit. */
export interface ToDeviceOutcome {
  /** Decrypted (or plaintext) to-device events for the app, after the crypto ones were handled. */
  events: Array<{ event: ToDeviceEvent; decrypted?: DecryptedToDevice }>;
  /** Megolm sessions that arrived: retry events waiting for them. */
  newSessions: Array<{ roomId: string; sessionId: string }>;
  /** Devices whose Olm messages did not decrypt: start a new session with them (unwedging). */
  wedged: Array<{ userId: string; senderKey: string }>;
}

/** An hour between unwedging attempts per device, so a broken peer cannot make us loop. */
const UNWEDGE_INTERVAL_MS = 3600_000;

/**
 * End-to-end encryption for one device: the Olm account and its keys on the server, device lists,
 * Olm and Megolm. Everything it stores goes through the client's Store in units of work.
 */
export class E2EEEngine {
  readonly devices: DeviceTracker;
  readonly olm: OlmService;
  readonly megolm: MegolmService;
  private readonly api: MatrixHttpApi;
  private readonly store: Store;
  private readonly pickler: Pickler;
  private readonly logger: Logger;
  private readonly userId: string;
  private readonly deviceId: string;
  private readonly txnId: () => string;
  /** One key upload at a time: generating keys and marking them published must not interleave. */
  private readonly keysMutex = new Mutex();

  constructor(opts: E2EEOptions) {
    this.api = opts.api;
    this.store = opts.store;
    this.pickler = new Pickler(opts.protocol, opts.pickleKey);
    this.logger = opts.logger;
    this.userId = opts.userId;
    this.deviceId = opts.deviceId;
    this.txnId = opts.txnId;
    this.devices = new DeviceTracker({ api: opts.api, store: opts.store, protocol: opts.protocol, logger: opts.logger });
    this.olm = new OlmService({
      api: opts.api,
      store: opts.store,
      pickler: this.pickler,
      devices: this.devices,
      logger: opts.logger,
      userId: opts.userId,
      deviceId: opts.deviceId,
    });
    this.megolm = new MegolmService({
      store: opts.store,
      pickler: this.pickler,
      olm: this.olm,
      devices: this.devices,
      logger: opts.logger,
      txnId: opts.txnId,
    });
  }

  get identityKeys(): { curve25519: string; ed25519: string } {
    return this.olm.identityKeys;
  }

  /**
   * Load the account, or create one for a new device. Its keys are stored before they are
   * uploaded: if the upload succeeds and the app then dies, the server's keys are still ours.
   */
  async init(): Promise<void> {
    const record = await this.store.transaction(async (tx) => {
      let rec = await tx.get<AccountRecord>("account", "account");
      if (!rec) {
        const account = this.pickler.protocol.newAccount();
        rec = { protocol: this.pickler.protocol.id, pickle: this.pickler.pickle(account), deviceKeysUploaded: false };
        tx.put("account", "account", rec);
        this.logger.info("created an Olm account", { deviceId: this.deviceId, curve25519: account.identityKeys().curve25519 });
      }
      return rec;
    });
    this.olm.setIdentity(this.pickler.account(record).identityKeys());
    if (!record.deviceKeysUploaded) await this.uploadKeys({ deviceKeys: true });
    // Our own other devices get room keys too.
    await this.store.transaction((tx) => this.devices.track(tx, [this.userId]));
  }

  /**
   * Keep the server's one-time keys topped up (half of the account's capacity, as libolm
   * advises, so keys the server still hands out are never dropped locally) and the fallback key
   * fresh once it has been used.
   */
  async maintainKeys(counts: Record<string, number> | undefined, unusedFallbackKeyTypes: string[] | undefined): Promise<void> {
    const needFallback = unusedFallbackKeyTypes !== undefined && !unusedFallbackKeyTypes.includes("signed_curve25519");
    const count = counts?.signed_curve25519;
    if (count === undefined && !needFallback) return;
    await this.uploadKeys({ oneTimeKeyCount: count, fallback: needFallback });
  }

  private uploadKeys(opts: { deviceKeys?: boolean; oneTimeKeyCount?: number; fallback?: boolean }): Promise<void> {
    return this.keysMutex.run(async () => {
      const body = await this.store.transaction(async (tx) => {
        const { record, account } = await loadAccount(tx, this.pickler);
        const max = account.maxNumberOfOneTimeKeys();
        const unpublished = Object.keys(account.oneTimeKeys()).length;
        const onServer = opts.oneTimeKeyCount ?? (opts.deviceKeys ? 0 : max);
        const wanted = Math.max(0, max - onServer - unpublished);
        if (wanted > 0) account.generateOneTimeKeys(wanted);
        if (opts.fallback || (opts.deviceKeys && Object.keys(account.fallbackKey()).length === 0)) account.generateFallbackKey();
        const { oneTime, fallback } = oneTimeKeysObject(account, this.userId, this.deviceId);
        const sendDeviceKeys = opts.deviceKeys || !record.deviceKeysUploaded;
        if (!sendDeviceKeys && Object.keys(oneTime).length === 0 && Object.keys(fallback).length === 0) return undefined;
        saveAccount(tx, this.pickler, record, account);
        return {
          ...(sendDeviceKeys ? { device_keys: deviceKeysObject(account, this.userId, this.deviceId) } : {}),
          ...(Object.keys(oneTime).length ? { one_time_keys: oneTime } : {}),
          ...(Object.keys(fallback).length ? { fallback_keys: fallback } : {}),
        };
      });
      if (!body) return;
      await this.api.request("POST", "/v3/keys/upload", { body });
      await this.store.transaction(async (tx) => {
        const { record, account } = await loadAccount(tx, this.pickler);
        account.markKeysAsPublished();
        saveAccount(tx, this.pickler, { ...record, deviceKeysUploaded: true }, account);
      });
    });
  }

  /**
   * The crypto part of a sync response, inside the sync's unit of work (so the sync token is
   * stored with its results): device list changes, then to-device messages. Room keys are stored
   * here; network work (key queries, unwedging, key uploads) comes after the commit.
   */
  async processSync(tx: Transaction, sync: SyncResult): Promise<ToDeviceOutcome> {
    await this.devices.handleDeviceLists(tx, sync.deviceLists);
    const outcome: ToDeviceOutcome = { events: [], newSessions: [], wedged: [] };
    for (const event of sync.toDevice) {
      if (
        typeof event?.type !== "string" ||
        typeof event.sender !== "string" ||
        typeof event.content !== "object" ||
        event.content === null
      )
        continue;
      if (event.type !== "m.room.encrypted") {
        // Room keys only count when they arrive encrypted (their origin is then authenticated).
        if (event.type === "m.room_key" || event.type === "m.forwarded_room_key") {
          this.logger.warn("ignoring an unencrypted room key", { sender: event.sender });
          continue;
        }
        outcome.events.push({ event });
        continue;
      }
      // A message that fails in an unexpected way is dropped and logged, never rethrown: the
      // sync's unit of work would fail with it, and the same message would block every retry.
      try {
        let decrypted: DecryptedToDevice;
        try {
          decrypted = await this.olm.decrypt(tx, event);
        } catch (e) {
          if (!(e instanceof OlmDecryptionError)) throw e;
          this.logger.warn("could not decrypt a to-device message", { sender: event.sender, code: e.code });
          if (e.code === "DECRYPT_FAILED" && typeof event.content.sender_key === "string")
            outcome.wedged.push({ userId: event.sender, senderKey: event.content.sender_key });
          continue;
        }
        if (decrypted.type === "m.room_key") {
          const stored = await this.megolm.handleRoomKey(tx, decrypted);
          if (stored) outcome.newSessions.push(stored);
        } else if (decrypted.type === "m.dummy") {
          // Only there to move the Olm session on.
        } else {
          outcome.events.push({ event: { type: decrypted.type, sender: decrypted.sender, content: decrypted.content }, decrypted });
        }
      } catch (e) {
        this.logger.error("dropping a to-device message that failed unexpectedly", { sender: event.sender, ...describeError(e) });
      }
    }
    return outcome;
  }

  /** After the sync's unit of work committed: key upload and unwedging. */
  async afterSync(sync: SyncResult, outcome: ToDeviceOutcome): Promise<void> {
    try {
      await this.maintainKeys(sync.oneTimeKeyCounts, sync.unusedFallbackKeyTypes);
    } catch (e) {
      this.logger.warn("could not upload one-time keys", describeError(e));
    }
    for (const w of outcome.wedged) {
      await this.unwedge(w.userId, w.senderKey).catch((e) =>
        this.logger.warn("could not unwedge an Olm session", { userId: w.userId, ...describeError(e) }),
      );
    }
  }

  /**
   * https://spec.matrix.org/v1.16/client-server-api/#recovering-from-undecryptable-messages: start
   * a new Olm session with the device and send it an m.dummy, so it can send to us again.
   */
  private async unwedge(userId: string, senderKey: string): Promise<void> {
    const key = `unwedge|${senderKey}`;
    const last = await this.store.get<number>("client", key);
    if (last && Date.now() - last < UNWEDGE_INTERVAL_MS) return;
    await this.devices.refresh([userId]);
    const device = await this.devices.deviceByCurveKey(userId, senderKey);
    if (!device) return;
    await this.store.transaction(async (tx) => tx.put("client", key, Date.now()));
    const failed = await this.olm.ensureSessions([device], { force: true });
    if (failed.length) return;
    const messages: Array<{ device: DeviceInfo; content: Record<string, unknown> }> = [];
    await this.store.transaction(async (tx) => {
      const content = await this.olm.encrypt(tx, device, "m.dummy", {});
      if (content) messages.push({ device, content });
    });
    await this.olm.sendToDevice("m.room.encrypted", messages, this.txnId);
    this.logger.info("sent m.dummy to unwedge an Olm session", { userId, deviceId: device.deviceId });
  }

  encryptRoomEvent(room: RoomEncryptionInfo, type: string, content: Record<string, unknown>): Promise<MegolmEncryptedContent> {
    return this.megolm.encrypt(room, type, content);
  }

  /** Decrypt in place; on failure, the event is marked failed with a code (never throws). */
  async decryptRoomEvent(event: MatrixEvent): Promise<boolean> {
    try {
      const { clear, info } = await this.megolm.decrypt(event);
      event.setDecrypted(clear, info);
      return true;
    } catch (e) {
      if (e instanceof MegolmDecryptionError) {
        event.setDecryptionFailed(e.code);
        if (e.code !== "MISSING_ROOM_KEY")
          this.logger.warn("could not decrypt a room event", { roomId: event.roomId, eventId: event.eventId, code: e.code });
        return false;
      }
      this.logger.error("room event decryption failed unexpectedly", { roomId: event.roomId, eventId: event.eventId, ...describeError(e) });
      event.setDecryptionFailed("BAD_ENCRYPTED_MESSAGE");
      return false;
    }
  }

  /** A membership change in an encrypted room: start tracking new members' devices. */
  async trackUsers(userIds: string[]): Promise<void> {
    await this.store.transaction((tx) => this.devices.track(tx, userIds));
  }

  /** Send an encrypted to-device message (for apps: verification and the like build on this). */
  async sendEncryptedToDevice(devices: DeviceInfo[], type: string, content: Record<string, unknown>): Promise<void> {
    await this.olm.ensureSessions(devices);
    const messages: Array<{ device: DeviceInfo; content: Record<string, unknown> }> = [];
    await this.store.transaction(async (tx) => {
      for (const d of devices) {
        const c = await this.olm.encrypt(tx, d, type, content);
        if (c) messages.push({ device: d, content: c });
      }
    });
    await this.olm.sendToDevice("m.room.encrypted", messages, this.txnId);
  }
}
