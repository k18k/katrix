import { UiaCallback } from "../auth/uia.js";
import { Logger } from "../util/logger.js";
import { KeyBackup } from "./backup.js";
import { CrossSigning } from "./cross-signing.js";
import { SecretStorage } from "./secret-storage.js";
export declare const SECRET_NAMES: {
  readonly master: "m.cross_signing.master";
  readonly selfSigning: "m.cross_signing.self_signing";
  readonly userSigning: "m.cross_signing.user_signing";
  readonly backup: "m.megolm_backup.v1";
};
/**
 * Recovery, as apps present it: one recovery key (or passphrase) that brings a new device the
 * user's identity and message history. It ties together cross-signing (the identity), the key
 * backup (the history) and secret storage (where the private keys of both are kept, encrypted
 * with the recovery key).
 */
export declare class Recovery {
  private readonly crossSigning;
  private readonly backup;
  private readonly secretStorage;
  private readonly logger;
  private readonly onNewSessions;
  constructor(opts: {
    crossSigning: CrossSigning;
    backup: KeyBackup;
    secretStorage: SecretStorage;
    logger: Logger;
    onNewSessions: (sessions: Array<{
      roomId: string;
      sessionId: string;
    }>) => void;
  });
  /** Whether the account has recovery set up (a default secret storage key) and what this device has. */
  status(): Promise<{
    setUp: boolean;
    crossSigningTrusted: boolean;
    backupActive: boolean;
  }>;
  /**
   * Set up recovery: new cross-signing keys (`auth` answers the server's user-interactive
   * authentication), a new key backup, and a secret storage key holding the private keys of
   * both. With a passphrase the key is derived from it; the returned recovery key opens it
   * either way. An account that has recovery already is refused unless `reset: true`, which
   * replaces the user's identity (contacts see it change) and starts a new backup.
   */
  setUp(opts?: {
    passphrase?: string;
    auth?: UiaCallback;
    reset?: boolean;
  }): Promise<{
    recoveryKey: string;
  }>;
  /** The secret storage key from what the user typed: a recovery key, or else a passphrase. */
  keyFrom(input: string): Promise<Uint8Array<ArrayBufferLike>>;
  /**
   * Recover on this device: verify it with the stored cross-signing keys, use the key backup,
   * and download every backed-up room key. Resolves with how many room keys were imported.
   */
  recover(recoveryKeyOrPassphrase: string): Promise<{
    importedKeys: number;
  }>;
}
//# sourceMappingURL=recovery.d.ts.map