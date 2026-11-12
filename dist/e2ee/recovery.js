import { decodeBase64, encodeBase64 } from "../shared/base64.js";
import { seedFromSecret } from "./cross-signing.js";
import { SecretStorageError, decodeRecoveryKey } from "./secret-storage.js";
// src/e2ee/recovery.ts
const SECRET_NAMES = {
	master: "m.cross_signing.master",
	selfSigning: "m.cross_signing.self_signing",
	userSigning: "m.cross_signing.user_signing",
	backup: "m.megolm_backup.v1"
};
/**
* Recovery, as apps present it: one recovery key (or passphrase) that brings a new device the
* user's identity and message history. It ties together cross-signing (the identity), the key
* backup (the history) and secret storage (where the private keys of both are kept, encrypted
* with the recovery key).
*/
var Recovery = class {
	crossSigning;
	backup;
	secretStorage;
	logger;
	onNewSessions;
	constructor(opts) {
		this.crossSigning = opts.crossSigning;
		this.backup = opts.backup;
		this.secretStorage = opts.secretStorage;
		this.logger = opts.logger;
		this.onNewSessions = opts.onNewSessions;
	}
	/** Whether the account has recovery set up (a default secret storage key) and what this device has. */
	async status() {
		return {
			setUp: await this.secretStorage.defaultKeyId() !== void 0,
			crossSigningTrusted: (await this.crossSigning.status()).trusted,
			backupActive: await this.backup.active() !== void 0
		};
	}
	/**
	* Set up recovery: new cross-signing keys (`auth` answers the server's user-interactive
	* authentication), a new key backup, and a secret storage key holding the private keys of
	* both. With a passphrase the key is derived from it; the returned recovery key opens it
	* either way. An account that has recovery already is refused unless `reset: true`, which
	* replaces the user's identity (contacts see it change) and starts a new backup.
	*/
	async setUp(opts = {}) {
		if (!opts.reset && await this.secretStorage.defaultKeyId() !== void 0) throw new Error("Recovery is set up already: recover() with the recovery key, or setUp({ reset: true })");
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
	async keyFrom(input) {
		let key;
		try {
			key = decodeRecoveryKey(input);
		} catch (e) {
			if (!(e instanceof SecretStorageError)) throw e;
		}
		key ??= await this.secretStorage.keyFromPassphrase(input).catch(() => void 0);
		if (!key || !await this.secretStorage.checkKey(key)) throw new SecretStorageError("BAD_KEY", "That is not the recovery key or passphrase");
		return key;
	}
	/**
	* Recover on this device: verify it with the stored cross-signing keys, use the key backup,
	* and download every backed-up room key. Resolves with how many room keys were imported.
	*/
	async recover(recoveryKeyOrPassphrase) {
		const key = await this.keyFrom(recoveryKeyOrPassphrase);
		const get = (name) => this.secretStorage.get(name, key);
		const [master, selfSigning, userSigning, backupKey] = await Promise.all([
			get(SECRET_NAMES.master),
			get(SECRET_NAMES.selfSigning),
			get(SECRET_NAMES.userSigning),
			get(SECRET_NAMES.backup)
		]);
		await this.crossSigning.importPrivateKeys({
			master: master ? seedFromSecret(master) : void 0,
			selfSigning: selfSigning ? seedFromSecret(selfSigning) : void 0,
			userSigning: userSigning ? seedFromSecret(userSigning) : void 0
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
};
export { Recovery, SECRET_NAMES };

//# sourceMappingURL=recovery.js.map