import type { MatrixHttpApi } from "../http/api.ts";
import type { E2EEProtocol } from "../protocol/protocol.ts";
import type { Store, Transaction } from "../storage/store.ts";
import type { Logger } from "../util/logger.ts";
import { type DeviceInfo, type UserDevicesRecord } from "./crypto-store.ts";
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
    private validate;
}
