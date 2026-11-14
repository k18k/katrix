import { MatrixHttpApi } from "../http/api.js";
import { MatrixEvent } from "../models/event.js";
import { MegolmEncryptedContent, ToDeviceEvent } from "../shared/events.js";
import { E2EEProtocol, PickleKey } from "../protocol/protocol.js";
import { Store, Transaction } from "../storage/store.js";
import { SyncResult } from "../sync/types.js";
import { Logger } from "../util/logger.js";
import { DeviceInfo } from "./crypto-store.js";
import { CrossSigning } from "./cross-signing.js";
import { DeviceTracker } from "./devices.js";
import { KeyBackup } from "./backup.js";
import { Recovery } from "./recovery.js";
import { SecretBox } from "./secret-box.js";
import { AccountDataAccess, SecretStorage } from "./secret-storage.js";
import { KeySharing } from "./sharing.js";
import { VerificationManager } from "./verification/manager.js";
import { CryptoPrimitives } from "../crypto/primitives.js";
import { MegolmService, RoomEncryptionInfo } from "./megolm.js";
import { DecryptedToDevice, OlmService } from "./olm.js";
export interface E2EEOptions {
  api: MatrixHttpApi;
  primitives: CryptoPrimitives;
  /** The user's account data (secret storage lives there). */
  accountData: AccountDataAccess;
  /**
   * Share room keys only with verified devices (cross-signed, or verified here), as Element's
   * "never send to unverified sessions". Default false: every device of the room's members
   * (trust on first use). Per room: E2EEEngine.setOnlyVerifiedDevices.
   */
  onlyVerifiedDevices?: boolean;
  /** Send a room event (encrypted when the room is): in-room verification. */
  sendRoomEvent: (roomId: string, type: string, content: Record<string, unknown>) => Promise<string>;
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
  events: Array<{
    event: ToDeviceEvent;
    decrypted?: DecryptedToDevice;
  }>;
  /** Megolm sessions that arrived: retry events waiting for them. */
  newSessions: Array<{
    roomId: string;
    sessionId: string;
  }>;
  /** Devices whose Olm messages did not decrypt: start a new session with them (unwedging). */
  wedged: Array<{
    userId: string;
    senderKey: string;
  }>;
  /** Key and secret sharing messages, handled after the commit (they may send answers). */
  sharing?: Array<{
    event: ToDeviceEvent;
    decrypted?: DecryptedToDevice;
  }>;
}
/**
 * End-to-end encryption for one device: the Olm account and its keys on the server, device lists,
 * Olm and Megolm. Everything it stores goes through the client's Store in units of work.
 */
export declare class E2EEEngine {
  readonly devices: DeviceTracker;
  readonly olm: OlmService;
  readonly megolm: MegolmService;
  /** Cross-signing keys, signatures and trust. */
  readonly crossSigning: CrossSigning;
  /** Seals secrets kept on this device with the pickle key. */
  readonly secretBox: SecretBox;
  /** Secrets in account data, encrypted with the user's recovery key. */
  readonly secretStorage: SecretStorage;
  /** Server-side key backup. */
  readonly backup: KeyBackup;
  /** Room key requests and forwarding, secret sharing, withheld notices. */
  readonly sharing: KeySharing;
  /** Set up and use recovery (cross-signing, backup and secret storage together). */
  readonly recovery: Recovery;
  /** Key verification (SAS, QR codes) with other users and the user's other devices. */
  readonly verification: VerificationManager;
  /** Called when room keys arrive outside a sync (from the backup, after a request): retry decryption. */
  onNewSessions?: (sessions: Array<{
    roomId: string;
    sessionId: string;
  }>) => void;
  private readonly restoreTried;
  private onlyVerified;
  private readonly api;
  private readonly store;
  private readonly pickler;
  private readonly logger;
  private readonly userId;
  private readonly deviceId;
  private readonly txnId;
  /** One key upload at a time: generating keys and marking them published must not interleave. */
  private readonly keysMutex;
  constructor(opts: E2EEOptions);
  get identityKeys(): {
    curve25519: string;
    ed25519: string;
  };
  /**
   * Load the account, or create one for a new device. Its keys are stored before they are
   * uploaded: if the upload succeeds and the app then dies, the server's keys are still ours.
   */
  init(): Promise<void>;
  /**
   * Keep the server's one-time keys topped up (half of the account's capacity, as libolm
   * advises, so keys the server still hands out are never dropped locally) and the fallback key
   * fresh once it has been used.
   */
  maintainKeys(counts: Record<string, number> | undefined, unusedFallbackKeyTypes: string[] | undefined): Promise<void>;
  private uploadKeys;
  /**
   * The crypto part of a sync response, inside the sync's unit of work (so the sync token is
   * stored with its results): device list changes, then to-device messages. Room keys are stored
   * here; network work (key queries, unwedging, key uploads) comes after the commit.
   */
  processSync(tx: Transaction, sync: SyncResult): Promise<ToDeviceOutcome>;
  /** After the sync's unit of work committed: key upload, unwedging, key sharing, backup. */
  afterSync(sync: SyncResult, outcome: ToDeviceOutcome): Promise<void>;
  /**
   * https://spec.matrix.org/v1.16/client-server-api/#recovering-from-undecryptable-messages: start
   * a new Olm session with the device and send it an m.dummy, so it can send to us again.
   */
  private unwedge;
  encryptRoomEvent(room: RoomEncryptionInfo, type: string, content: Record<string, unknown>): Promise<{
    algorithm: string;
    ciphertext: string;
    session_id: string;
    sender_key: string;
    device_id: string;
    "m.relates_to"?: MegolmEncryptedContent["m.relates_to"];
  }>;
  /** Decrypt in place; on failure, the event is marked failed with a code (never throws). */
  decryptRoomEvent(event: MatrixEvent): Promise<boolean>;
  /**
   * An event's room key is missing: try the key backup (once per session per run), else ask the
   * user's other devices. Sessions found come through onNewSessions.
   */
  keyMissing(event: MatrixEvent): Promise<void>;
  /**
   * After this device and another of ours verified each other: ask it for the cross-signing and
   * backup keys this device lacks (it answers only verified devices), and use them.
   */
  afterOwnVerification(): Promise<void>;
  /** Share keys only with verified devices: everywhere (`roomId` omitted), or in one room (undefined: as everywhere). */
  setOnlyVerifiedDevices(only: boolean | undefined, roomId?: string): Promise<void>;
  /** A membership change in an encrypted room: start tracking new members' devices. */
  trackUsers(userIds: string[]): Promise<void>;
  /** Send an encrypted to-device message (for apps: verification and the like build on this). */
  sendEncryptedToDevice(devices: DeviceInfo[], type: string, content: Record<string, unknown>): Promise<void>;
}
//# sourceMappingURL=engine.d.ts.map