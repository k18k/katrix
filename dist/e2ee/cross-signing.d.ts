import { Logger } from "../util/logger.js";
import { DeviceKeys } from "../shared/api/keys.js";
import { MatrixHttpApi } from "../http/api.js";
import { UiaCallback } from "../auth/uia.js";
import { CryptoPrimitives } from "../crypto/primitives.js";
import { E2EEProtocol } from "../protocol/protocol.js";
import { Store } from "../storage/store.js";
import { DeviceTracker } from "./devices.js";
import { SecretBox } from "./secret-box.js";
/** The private halves of the cross-signing keys: 32-byte Ed25519 seeds. */
export interface CrossSigningPrivateKeys {
  master?: Uint8Array;
  selfSigning?: Uint8Array;
  userSigning?: Uint8Array;
}
export interface UserTrust {
  /** The user's master key, if they have set up cross-signing. */
  masterKey?: string;
  /** Verified: by our user-signing key (cross-signing), or directly on this device. Our own user: our master key is trusted. */
  verified: boolean;
  /** Their master key is not the one first seen, and the new one is not verified: show it before going on. */
  identityChanged: boolean;
}
export interface DeviceTrust {
  /** Verified directly on this device (SAS, QR). */
  locallyVerified: boolean;
  /** Signed by its owner's self-signing key, and the owner is verified. */
  crossSigned: boolean;
  verified: boolean;
}
/**
 * Cross-signing (https://spec.matrix.org/v1.19/client-server-api/#cross-signing): a user's master
 * key signs their self-signing key (which signs their devices) and their user-signing key (which
 * signs other users' master keys), so verifying a user once covers all their devices.
 *
 * The master key's private half is never stored on this device: the spec forbids storing it
 * without a secure means of storage, and the SDK cannot know whether the app's storage is one.
 * It lives in secret storage (SecretStorage), and is needed only to replace the other two keys.
 * The self-signing and user-signing private keys are kept, sealed with the pickle key.
 */
export declare class CrossSigning {
  private readonly api;
  private readonly store;
  private readonly primitives;
  private readonly protocol;
  private readonly devices;
  private readonly box;
  private readonly logger;
  private readonly userId;
  private readonly deviceId;
  /** Our own device keys, signed by our device (as uploaded). */
  private readonly ownDeviceKeys;
  /** Sign an object with our device's Ed25519 key (adds to `signatures`). */
  private readonly signWithDevice;
  constructor(opts: {
    api: MatrixHttpApi;
    store: Store;
    primitives: CryptoPrimitives;
    protocol: E2EEProtocol;
    devices: DeviceTracker;
    box: SecretBox;
    logger: Logger;
    userId: string;
    deviceId: string;
    ownDeviceKeys: () => Promise<DeviceKeys>;
    signWithDevice: <T extends object>(obj: T) => Promise<T>;
  });
  private sign;
  private keyObject;
  /**
   * Create new cross-signing keys and upload them (user-interactive authentication: the server
   * asks for the password, or an OAuth approval), then sign this device with them. Replaces
   * any keys the user had: other users see a changed identity, and devices must be verified
   * again. Resolves with the private keys, for the app to put in secret storage.
   */
  bootstrap(auth: UiaCallback | undefined): Promise<Required<CrossSigningPrivateKeys>>;
  private uploadSignatures;
  /** The self-signing and user-signing private keys this device holds. */
  privateKeys(): Promise<CrossSigningPrivateKeys>;
  private ownRecord;
  /**
   * Take private keys from secret storage or another device (secret sharing). Each must match
   * the user's public key on the server, or it is refused. With the master key, our identity is
   * trusted here; with the self-signing key, this device signs itself.
   */
  importPrivateKeys(keys: CrossSigningPrivateKeys): Promise<void>;
  /** Our master key is trusted here: we made it, restored it, or verified it from another of our devices. */
  markOwnIdentityVerified(): Promise<void>;
  /** Whether the user has cross-signing keys on the server, and which private keys this device has. */
  status(): Promise<{
    publishedOnServer: boolean;
    trusted: boolean;
    selfSigning: boolean;
    userSigning: boolean;
  }>;
  userTrust(userId: string): Promise<UserTrust>;
  private ownIdentityTrusted;
  deviceTrust(userId: string, deviceId: string): Promise<DeviceTrust>;
  /** Accept a user's new identity (master key) after showing the change: it becomes the pinned one. */
  acceptIdentityChange(userId: string): Promise<void>;
  /** Mark a device verified on this device (after SAS or QR). */
  setDeviceVerified(userId: string, deviceId: string, verified?: boolean): Promise<void>;
  /** Sign one of our own devices with our self-signing key (so our other devices and contacts trust it). */
  signOwnDevice(deviceId: string): Promise<void>;
  /**
   * Verify another user: sign their master key with our user-signing key, which makes every
   * device they sign trusted here and on our other devices. `expectedMasterKey` pins the key
   * seen during the verification (the spec requires the keys not to change during it).
   */
  verifyUser(userId: string, expectedMasterKey?: string): Promise<void>;
  /** A user's master key, if any (for verification: their identity as a "device"). */
  masterKey(userId: string): Promise<string | undefined>;
}
//# sourceMappingURL=cross-signing.d.ts.map