import type { UiaCallback } from "../auth/uia.ts";
import type { Logger } from "../util/logger.ts";
import { decodeBase64, encodeBase64 } from "@katrix/shared";
import type { KeyBackup } from "./backup.ts";
import { seedFromSecret, type CrossSigning } from "./cross-signing.ts";
import { decodeRecoveryKey, SecretStorageError, type SecretStorage } from "./secret-storage.ts";

export const SECRET_NAMES = {
  master: "m.cross_signing.master",
  selfSigning: "m.cross_signing.self_signing",
  userSigning: "m.cross_signing.user_signing",
  backup: "m.megolm_backup.v1",
} as const;

/**
 * Recovery, as apps present it: one recovery key (or passphrase) that brings a new device the
 * user's identity and message history. It ties together cross-signing (the identity), the key
 * backup (the history) and secret storage (where the private keys of both are kept, encrypted
 * with the recovery key).
 */
export class Recovery {
  private readonly crossSigning: CrossSigning;
  private readonly backup: KeyBackup;
  private readonly secretStorage: SecretStorage;
  private readonly logger: Logger;
  private readonly onNewSessions: (sessions: Array<{ roomId: string; sessionId: string }>) => void;

  constructor(opts: {
    crossSigning: CrossSigning;
    backup: KeyBackup;
    secretStorage: SecretStorage;
    logger: Logger;
    onNewSessions: (sessions: Array<{ roomId: string; sessionId: string }>) => void;
  }) {
    this.crossSigning = opts.crossSigning;
    this.backup = opts.backup;
    this.secretStorage = opts.secretStorage;
    this.logger = opts.logger;
    this.onNewSessions = opts.onNewSessions;
  }

  /** Whether the account has recovery set up (a default secret storage key) and what this device has. */
  async status(): Promise<{ setUp: boolean; crossSigningTrusted: boolean; backupActive: boolean }> {
    return {
      setUp: (await this.secretStorage.defaultKeyId()) !== undefined,
      crossSigningTrusted: (await this.crossSigning.status()).trusted,
      backupActive: (await this.backup.active()) !== undefined,
    };
  }

  /**
   * Set up recovery: new cross-signing keys (`auth` answers the server's user-interactive
   * authentication), a new key backup, and a secret storage key holding the private keys of
   * both. With a passphrase the key is derived from it; the returned recovery key opens it
   * either way. An account that has recovery already is refused unless `reset: true`, which
   * replaces the user's identity (contacts see it change) and starts a new backup.
   */
  async setUp(opts: { passphrase?: string; auth?: UiaCallback; reset?: boolean } = {}): Promise<{ recoveryKey: string }> {
    if (!opts.reset && (await this.secretStorage.defaultKeyId()) !== undefined)
      throw new Error("Recovery is set up already: recover() with the recovery key, or setUp({ reset: true })");
    const keys = await this.crossSigning.bootstrap(opts.auth);
    const backup = await this.backup.create({ masterKey: keys.master });
    const { key, recoveryKey } = await this.secretStorage.createKey({ passphrase: opts.passphrase });
    await this.secretStorage.store(SECRET_NAMES.master, encodeBase64(keys.master), key);
    await this.secretStorage.store(SECRET_NAMES.selfSigning, encodeBase64(keys.selfSigning), key);
    await this.secretStorage.store(SECRET_NAMES.userSigning, encodeBase64(keys.userSigning), key);
    await this.secretStorage.store(SECRET_NAMES.backup, encodeBase64(backup.privateKey), key);
    await this.backup.backupPending().catch((e) => this.logger.warn("the first key backup upload failed", { error: String(e) }));
    return { recoveryKey };
  }

  /** The secret storage key from what the user typed: a recovery key, or else a passphrase. */
  async keyFrom(input: string): Promise<Uint8Array> {
    let key: Uint8Array | undefined;
    try {
      key = decodeRecoveryKey(input);
    } catch (e) {
      if (!(e instanceof SecretStorageError)) throw e;
    }
    key ??= await this.secretStorage.keyFromPassphrase(input).catch(() => undefined);
    if (!key || !(await this.secretStorage.checkKey(key)))
      throw new SecretStorageError("BAD_KEY", "That is not the recovery key or passphrase");
    return key;
  }

  /**
   * Recover on this device: verify it with the stored cross-signing keys, use the key backup,
   * and download every backed-up room key. Resolves with how many room keys were imported.
   */
  async recover(recoveryKeyOrPassphrase: string): Promise<{ importedKeys: number }> {
    const key = await this.keyFrom(recoveryKeyOrPassphrase);
    const get = (name: string) => this.secretStorage.get(name, key);
    const [master, selfSigning, userSigning, backupKey] = await Promise.all([
      get(SECRET_NAMES.master),
      get(SECRET_NAMES.selfSigning),
      get(SECRET_NAMES.userSigning),
      get(SECRET_NAMES.backup),
    ]);
    await this.crossSigning.importPrivateKeys({
      master: master ? seedFromSecret(master) : undefined,
      selfSigning: selfSigning ? seedFromSecret(selfSigning) : undefined,
      userSigning: userSigning ? seedFromSecret(userSigning) : undefined,
    });
    let importedKeys = 0;
    if (backupKey) {
      const privateKey = decodeBase64(backupKey);
      await this.backup.enableWithPrivateKey(privateKey);
      const sessions = await this.backup.restore({ privateKey });
      importedKeys = sessions.length;
      if (sessions.length) this.onNewSessions(sessions);
    }
    return { importedKeys };
  }
}
