import type { MatrixEvent, DecryptionFailureCode, DecryptionInfo } from "../models/event.ts";
import type { MegolmEncryptedContent } from "../models/types.ts";
import type { Store, Transaction } from "../storage/store.ts";
import { type Logger } from "../util/logger.ts";
import { type Pickler } from "./crypto-store.ts";
import type { DeviceTracker } from "./devices.ts";
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
export declare class MegolmDecryptionError extends Error {
    readonly code: DecryptionFailureCode;
    constructor(code: DecryptionFailureCode, message: string);
}
/** Megolm in rooms (m.megolm.v1.aes-sha2): our outbound sessions and their sharing, and decryption. */
export declare class MegolmService {
    private readonly store;
    private readonly pickler;
    private readonly olm;
    private readonly devices;
    private readonly logger;
    private readonly txnId;
    private readonly roomLocks;
    constructor(opts: {
        store: Store;
        pickler: Pickler;
        olm: OlmService;
        devices: DeviceTracker;
        logger: Logger;
        txnId: () => string;
    });
    /** Encrypt an event for a room: rotate the session if due, share it with new devices, encrypt. */
    encrypt(room: RoomEncryptionInfo, type: string, content: Record<string, unknown>): Promise<MegolmEncryptedContent>;
    /** Devices to share with: every device with Megolm of every target user, except this one. */
    private targetDevices;
    /**
     * The outbound session to use, rotated when: its message or time budget is used up; the room's
     * encryption settings or history visibility changed; or a device that has the key is no longer
     * a target (a member left, a device was removed), as it must not read what follows.
     */
    private prepareSession;
    /** Send the session key (at its current index) to every target device that does not have it. */
    private share;
    private encryptWith;
    /** Force a new session for the next message in the room (for example after a membership change). */
    discardSession(roomId: string): Promise<void>;
    /**
     * An m.room_key that arrived over Olm. Returns the session's room and ID if it was stored. The
     * session key's signature is verified by the protocol (the key proves its own origin), and the
     * session ID must be the key's.
     */
    handleRoomKey(tx: Transaction, decrypted: DecryptedToDevice): Promise<{
        roomId: string;
        sessionId: string;
    } | undefined>;
    /**
     * Decrypt a room event. Checks, beyond the protocol's MAC and signature: the plaintext names the
     * event's room; the session belongs to the event's sender; and no other event used the same
     * message index of the session before (a replay). Throws MegolmDecryptionError.
     */
    decrypt(event: MatrixEvent): Promise<{
        clear: {
            type: string;
            content: Record<string, unknown>;
        };
        info: DecryptionInfo;
    }>;
}
