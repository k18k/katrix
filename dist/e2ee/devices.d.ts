import { MatrixHttpApi } from "../http/api.js";
import { E2EEProtocol } from "../protocol/protocol.js";
import { Store, Transaction } from "../storage/store.js";
import { Logger } from "../util/logger.js";
import { DeviceInfo, UserDevicesRecord, UserTrustRecord } from "./crypto-store.js";
/**
 * Device list tracking (https://spec.matrix.org/v1.16/client-server-api/#tracking-the-device-list-for-a-user):
 * users we share an encrypted room with are "tracked"; /sync's device_lists.changed marks them
 * outdated, and their keys are queried again before we next encrypt for them.
 *
 * Every device's keys must be signed by the device's own Ed25519 key and name the right user and
 * device. A device whose keys change is not updated: the spec's "Downloading keys" asks clients
 * to reject a known device whose Ed25519 key changed (it would let the server swap in a key of its
 * own), and the Curve25519 key is bound to it the same way here.
 */
export declare class DeviceTracker {
  private readonly api;
  private readonly store;
  private readonly protocol;
  private readonly logger;
  private readonly mutex;
  constructor(opts: {
    api: MatrixHttpApi;
    store: Store;
    protocol: E2EEProtocol;
    logger: Logger;
  });
  getUser(userId: string, tx?: Transaction): Promise<UserDevicesRecord | undefined>;
  devices(userId: string, tx?: Transaction): Promise<DeviceInfo[]>;
  /** The device of `userId` with this Curve25519 key, if known. */
  deviceByCurveKey(userId: string, curve25519: string, tx?: Transaction): Promise<DeviceInfo | undefined>;
  /** Start tracking users (newly tracked ones are outdated until queried). */
  track(tx: Transaction, userIds: Iterable<string>): Promise<void>;
  /** device_lists from /sync. */
  handleDeviceLists(tx: Transaction, lists: {
    changed: string[];
    left: string[];
  }): Promise<void>;
  isOutdated(userId: string): Promise<boolean>;
  /** Query keys of the given users that are outdated (all given users if `force`). */
  refresh(userIds: string[], opts?: {
    force?: boolean;
  }): Promise<void>;
  private query;
  /**
   * A user's cross-signing keys from a query, each checked: it names the user, has the right
   * usage and one key, and the self-signing and user-signing keys carry the master key's
   * signature. Keys that fail are dropped (and with a bad master key, all of them).
   */
  private crossSigningKeys;
  /**
   * The users whose devices changed between two sync tokens (GET /keys/changes): they are marked
   * outdated, and their keys queried again before we next encrypt for them. For a client that
   * resumes from an older token than its device lists were last updated at.
   */
  changesBetween(from: string, to: string): Promise<{
    changed: string[];
    left: string[];
  }>;
  /** Change what this device trusts about a user (the record is created if the user is not known yet). */
  updateTrust(userId: string, change: (trust: UserTrustRecord) => UserTrustRecord): Promise<void>;
  private validate;
}
//# sourceMappingURL=devices.d.ts.map