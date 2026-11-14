import { MatrixHttpApi } from "../http/api.js";
import { ToDeviceEvent } from "../shared/events.js";
import { OlmMessage } from "../protocol/protocol.js";
import { Store, Transaction } from "../storage/store.js";
import { Logger } from "../util/logger.js";
import { DeviceInfo, OlmSessionRecord, Pickler } from "./crypto-store.js";
import { DeviceTracker } from "./devices.js";
/** A decrypted to-device event and what the Olm layer proved about its origin. */
export interface DecryptedToDevice {
  type: string;
  content: Record<string, unknown>;
  sender: string;
  /** The Curve25519 key of the sending device: authenticated by the Olm session. */
  senderKey: string;
  /** The Ed25519 key the sender claims in the payload (checked against its device if known). */
  claimedEd25519Key: string;
  senderDevice?: DeviceInfo;
}
/**
 * Olm sessions with other devices (m.olm.v1.curve25519-aes-sha2,
 * https://spec.matrix.org/v1.16/client-server-api/#molmv1curve25519-aes-sha2): encrypting
 * to-device payloads, decrypting them, and starting sessions from claimed one-time keys.
 */
export declare class OlmService {
  private readonly api;
  private readonly store;
  private readonly pickler;
  private readonly devices;
  private readonly logger;
  readonly userId: string;
  readonly deviceId: string;
  private identity?;
  constructor(opts: {
    api: MatrixHttpApi;
    store: Store;
    pickler: Pickler;
    devices: DeviceTracker;
    logger: Logger;
    userId: string;
    deviceId: string;
  });
  setIdentity(identity: {
    curve25519: string;
    ed25519: string;
  }): void;
  get identityKeys(): {
    curve25519: string;
    ed25519: string;
  };
  sessions(tx: Transaction | Store, senderKey: string): Promise<OlmSessionRecord[]>;
  /**
   * The session to send with: the one we last received on (the spec asks clients to prefer it,
   * as it is the one the other side is sure to have), else the newest.
   */
  private static preferred;
  /**
   * Make sure we have an Olm session with each device, claiming one-time keys for those without.
   * Returns the devices we could not get a session with (no one-time key, invalid signature).
   */
  ensureSessions(devices: DeviceInfo[], opts?: {
    force?: boolean;
  }): Promise<DeviceInfo[]>;
  /**
   * Encrypt a to-device payload for `device` (which must have a session: ensureSessions). The
   * payload binds sender and recipient, as the spec requires, so it cannot be redirected.
   */
  encrypt(tx: Transaction, device: DeviceInfo, type: string, content: Record<string, unknown>): Promise<{
    algorithm: string;
    sender_key: string;
    ciphertext: {
      [device.curve25519]: OlmMessage;
    };
  } | undefined>;
  /**
   * Decrypt an m.room.encrypted to-device event. A pre-key message that no existing session
   * matches starts a new inbound session (using up our one-time key); one that an existing
   * session matches but that does not decrypt is refused (a replay must not start a second
   * session from a fallback key).
   */
  decrypt(tx: Transaction, event: ToDeviceEvent): Promise<{
    type: string;
    content: Record<string, unknown>;
    sender: string;
    senderKey: string;
    claimedEd25519Key: string;
    senderDevice: DeviceInfo | undefined;
  }>;
  /** PUT /sendToDevice, in chunks (large rooms can mean thousands of devices). */
  sendToDevice(type: string, messages: Array<{
    device: DeviceInfo;
    content: Record<string, unknown>;
  }>, txnId: () => string): Promise<void>;
}
//# sourceMappingURL=olm.d.ts.map