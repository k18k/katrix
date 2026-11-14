import { E2EEProtocol } from "../protocol/protocol.js";
import { Store } from "../storage/store.js";
import { Logger } from "../util/logger.js";
import { ToDeviceEvent } from "../shared/events.js";
import { Pickler } from "./crypto-store.js";
import { CrossSigning } from "./cross-signing.js";
import { DeviceTracker } from "./devices.js";
import { DecryptedToDevice, OlmService } from "./olm.js";
/** A secret this device can give to the user's other verified devices, by name. */
export type SecretProvider = (name: string) => Promise<string | undefined>;
/**
 * Sharing keys and secrets between the user's own devices
 * (https://spec.matrix.org/v1.19/client-server-api/#key-requests and #sharing): room key
 * requests and m.forwarded_room_key, m.secret.request and m.secret.send, and the
 * m.room_key.withheld notices that say why a key will not come.
 *
 * Only the user's own verified devices are answered, and only answers from them, to requests
 * this device sent, are accepted: a server, or another user, cannot get keys or plant them.
 */
export declare class KeySharing {
  private readonly store;
  private readonly pickler;
  private readonly protocol;
  private readonly olm;
  private readonly devices;
  private readonly crossSigning;
  private readonly logger;
  private readonly userId;
  private readonly deviceId;
  private readonly txnId;
  private readonly sendPlain;
  private readonly secrets;
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
  });
  private verifiedOwnDevices;
  private isVerifiedOwnDevice;
  /** Ask the user's other devices for a room key this device lacks (at most every 15 minutes per session). */
  requestRoomKey(roomId: string, sessionId: string, senderKey?: string): Promise<void>;
  /** An m.room_key_request from another device: answered with the key if it is ours and verified. */
  handleRoomKeyRequest(event: ToDeviceEvent): Promise<void>;
  /**
   * An m.forwarded_room_key (decrypted over Olm): stored only if it comes from a verified device
   * of ours and answers a request this device made. Returns the session if it was stored.
   */
  handleForwardedRoomKey(decrypted: DecryptedToDevice): Promise<{
    roomId: string;
    sessionId: string;
  } | undefined>;
  /** m.room_key.withheld: the sender will not share the key, and says why (shown on the undecryptable events). */
  handleWithheld(event: ToDeviceEvent): Promise<void>;
  withheld(roomId: string, sessionId: string): Promise<{
    code: string;
    reason?: string;
  } | undefined>;
  /**
   * Ask the user's other verified devices for a secret (m.cross_signing.self_signing,
   * m.megolm_backup.v1, …). Resolves with the first answer from one of them, or undefined after
   * `timeoutMs`.
   */
  requestSecret(name: string, timeoutMs?: number): Promise<string | undefined>;
  /** An m.secret.request from another device of ours: answered over Olm if it is verified and we have the secret. */
  handleSecretRequest(event: ToDeviceEvent): Promise<void>;
  /** An m.secret.send (decrypted over Olm): accepted only from a device we asked, of ours and verified. */
  handleSecretSend(decrypted: DecryptedToDevice): Promise<void>;
}
//# sourceMappingURL=sharing.d.ts.map