import type { MatrixHttpApi } from "../http/api.ts";
import type { MatrixEvent } from "../models/event.ts";
import type { MegolmEncryptedContent, ToDeviceEvent } from "../models/types.ts";
import type { E2EEProtocol, PickleKey } from "../protocol/protocol.ts";
import type { Store, Transaction } from "../storage/store.ts";
import type { SyncResult } from "../sync/types.ts";
import { type Logger } from "../util/logger.ts";
import { type DeviceInfo } from "./crypto-store.ts";
import { DeviceTracker } from "./devices.ts";
import { MegolmService, type RoomEncryptionInfo } from "./megolm.ts";
import { OlmService, type DecryptedToDevice } from "./olm.ts";
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
}
/**
 * End-to-end encryption for one device: the Olm account and its keys on the server, device lists,
 * Olm and Megolm. Everything it stores goes through the client's Store in units of work.
 */
export declare class E2EEEngine {
    readonly devices: DeviceTracker;
    readonly olm: OlmService;
    readonly megolm: MegolmService;
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
    /** After the sync's unit of work committed: key upload and unwedging. */
    afterSync(sync: SyncResult, outcome: ToDeviceOutcome): Promise<void>;
    /**
     * https://spec.matrix.org/v1.16/client-server-api/#recovering-from-undecryptable-messages: start
     * a new Olm session with the device and send it an m.dummy, so it can send to us again.
     */
    private unwedge;
    encryptRoomEvent(room: RoomEncryptionInfo, type: string, content: Record<string, unknown>): Promise<MegolmEncryptedContent>;
    /** Decrypt in place; on failure, the event is marked failed with a code (never throws). */
    decryptRoomEvent(event: MatrixEvent): Promise<boolean>;
    /** A membership change in an encrypted room: start tracking new members' devices. */
    trackUsers(userIds: string[]): Promise<void>;
    /** Send an encrypted to-device message (for apps: verification and the like build on this). */
    sendEncryptedToDevice(devices: DeviceInfo[], type: string, content: Record<string, unknown>): Promise<void>;
}
