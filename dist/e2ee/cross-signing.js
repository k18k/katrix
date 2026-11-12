import { withUserInteractiveAuth } from "../auth/uia.js";
import { decodeBase64, encodeBase64 } from "../shared/base64.js";
import { signingJson } from "../shared/canonical-json.js";
import { encodeUtf8 } from "../shared/utf8.js";
import { verifyObject } from "./keys.js";
import { publicKeyOf } from "./devices.js";
// src/e2ee/cross-signing.ts
const STORE_KEY = "cross_signing";
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
var CrossSigning = class {
	api;
	store;
	primitives;
	protocol;
	devices;
	box;
	logger;
	userId;
	deviceId;
	/** Our own device keys, signed by our device (as uploaded). */
	ownDeviceKeys;
	/** Sign an object with our device's Ed25519 key (adds to `signatures`). */
	signWithDevice;
	constructor(opts) {
		this.api = opts.api;
		this.store = opts.store;
		this.primitives = opts.primitives;
		this.protocol = opts.protocol;
		this.devices = opts.devices;
		this.box = opts.box;
		this.logger = opts.logger;
		this.userId = opts.userId;
		this.deviceId = opts.deviceId;
		this.ownDeviceKeys = opts.ownDeviceKeys;
		this.signWithDevice = opts.signWithDevice;
	}
	sign(seed, publicKey, obj) {
		const signature = encodeBase64(this.primitives.ed25519Sign(seed, encodeUtf8(signingJson(obj))));
		const existing = obj.signatures ?? {};
		return {
			...obj,
			signatures: {
				...existing,
				[this.userId]: {
					...existing[this.userId],
					[`ed25519:${publicKey}`]: signature
				}
			}
		};
	}
	keyObject(usage, publicKey) {
		return {
			user_id: this.userId,
			usage: [usage],
			keys: { [`ed25519:${publicKey}`]: publicKey }
		};
	}
	/**
	* Create new cross-signing keys and upload them (user-interactive authentication: the server
	* asks for the password, or an OAuth approval), then sign this device with them. Replaces
	* any keys the user had: other users see a changed identity, and devices must be verified
	* again. Resolves with the private keys, for the app to put in secret storage.
	*/
	async bootstrap(auth) {
		const master = this.primitives.ed25519GenerateKeyPair();
		const selfSigning = this.primitives.ed25519GenerateKeyPair();
		const userSigning = this.primitives.ed25519GenerateKeyPair();
		const mpk = encodeBase64(master.publicKey);
		const sspk = encodeBase64(selfSigning.publicKey);
		const uspk = encodeBase64(userSigning.publicKey);
		const masterKey = this.keyObject("master", mpk);
		const sskObj = this.sign(master.secretKey, mpk, this.keyObject("self_signing", sspk));
		const uskObj = this.sign(master.secretKey, mpk, this.keyObject("user_signing", uspk));
		await withUserInteractiveAuth((a) => this.api.endpoint("POST /v3/keys/device_signing/upload", {}, { body: {
			master_key: masterKey,
			self_signing_key: sskObj,
			user_signing_key: uskObj,
			auth: a
		} }), auth);
		await this.store.transaction(async (tx) => {
			tx.put("account", STORE_KEY, {
				selfSigning: this.box.seal("m.cross_signing.self_signing", selfSigning.secretKey),
				userSigning: this.box.seal("m.cross_signing.user_signing", userSigning.secretKey)
			});
		});
		await this.devices.updateTrust(this.userId, (t) => ({
			...t,
			verifiedMaster: mpk,
			pinnedMaster: mpk
		}));
		const device = this.sign(selfSigning.secretKey, sspk, await this.ownDeviceKeys());
		const signedMaster = await this.signWithDevice(masterKey);
		await this.uploadSignatures({ [this.userId]: {
			[this.deviceId]: device,
			[mpk]: signedMaster
		} });
		await this.devices.refresh([this.userId], { force: true });
		this.logger.info("set up cross-signing", { master: mpk });
		return {
			master: master.secretKey,
			selfSigning: selfSigning.secretKey,
			userSigning: userSigning.secretKey
		};
	}
	async uploadSignatures(body) {
		const res = await this.api.endpoint("POST /v3/keys/signatures/upload", {}, { body });
		const failures = Object.entries(res.failures ?? {}).flatMap(([user, keys]) => Object.keys(keys).map((k) => `${user} ${k}`));
		if (failures.length) throw new Error(`The server rejected signatures for ${failures.join(", ")}`);
	}
	/** The self-signing and user-signing private keys this device holds. */
	async privateKeys() {
		const stored = await this.store.get("account", STORE_KEY);
		return {
			selfSigning: stored?.selfSigning ? this.box.open("m.cross_signing.self_signing", stored.selfSigning) : void 0,
			userSigning: stored?.userSigning ? this.box.open("m.cross_signing.user_signing", stored.userSigning) : void 0
		};
	}
	async ownRecord(refresh = false) {
		if (refresh) await this.devices.refresh([this.userId], { force: true });
		return this.devices.getUser(this.userId);
	}
	/**
	* Take private keys from secret storage or another device (secret sharing). Each must match
	* the user's public key on the server, or it is refused. With the master key, our identity is
	* trusted here; with the self-signing key, this device signs itself.
	*/
	async importPrivateKeys(keys) {
		const cs = (await this.ownRecord(true))?.crossSigning;
		const matches = (seed, key) => seed !== void 0 && key !== void 0 && encodeBase64(this.primitives.ed25519PublicKey(seed)) === publicKeyOf(key);
		for (const [name, seed, key] of [
			[
				"master",
				keys.master,
				cs?.master
			],
			[
				"self-signing",
				keys.selfSigning,
				cs?.selfSigning
			],
			[
				"user-signing",
				keys.userSigning,
				cs?.userSigning
			]
		]) if (seed !== void 0 && !matches(seed, key)) throw new Error(`The ${name} key does not match the user's cross-signing keys`);
		await this.store.transaction(async (tx) => {
			const stored = await tx.get("account", STORE_KEY) ?? {};
			tx.put("account", STORE_KEY, {
				selfSigning: keys.selfSigning ? this.box.seal("m.cross_signing.self_signing", keys.selfSigning) : stored.selfSigning,
				userSigning: keys.userSigning ? this.box.seal("m.cross_signing.user_signing", keys.userSigning) : stored.userSigning
			});
		});
		if (keys.master) await this.devices.updateTrust(this.userId, (t) => ({
			...t,
			verifiedMaster: publicKeyOf(cs.master)
		}));
		if (keys.selfSigning && !(await this.deviceTrust(this.userId, this.deviceId)).crossSigned) await this.signOwnDevice(this.deviceId);
	}
	/** Our master key is trusted here: we made it, restored it, or verified it from another of our devices. */
	async markOwnIdentityVerified() {
		const master = (await this.ownRecord())?.crossSigning?.master;
		if (!master) throw new Error("The user has no cross-signing keys");
		await this.devices.updateTrust(this.userId, (t) => ({
			...t,
			verifiedMaster: publicKeyOf(master)
		}));
	}
	/** Whether the user has cross-signing keys on the server, and which private keys this device has. */
	async status() {
		const rec = await this.ownRecord();
		const priv = await this.privateKeys();
		return {
			publishedOnServer: rec?.crossSigning?.master !== void 0,
			trusted: (await this.userTrust(this.userId)).verified,
			selfSigning: priv.selfSigning !== void 0,
			userSigning: priv.userSigning !== void 0
		};
	}
	async userTrust(userId) {
		const rec = await this.devices.getUser(userId);
		const master = rec?.crossSigning?.master;
		const masterKey = master ? publicKeyOf(master) : void 0;
		let verified = false;
		if (masterKey) {
			if (rec?.trust?.verifiedMaster === masterKey) verified = userId === this.userId || await this.ownIdentityTrusted();
			else if (userId !== this.userId && await this.ownIdentityTrusted()) {
				const usk = (await this.ownRecord())?.crossSigning?.userSigning;
				const uskPub = usk ? publicKeyOf(usk) : void 0;
				verified = master !== void 0 && uskPub !== void 0 && verifyObject(this.protocol, master, this.userId, uskPub, uskPub);
			}
		}
		const pinned = rec?.trust?.pinnedMaster;
		return {
			masterKey,
			verified,
			identityChanged: !verified && pinned !== void 0 && masterKey !== void 0 && pinned !== masterKey
		};
	}
	async ownIdentityTrusted() {
		const rec = await this.ownRecord();
		const master = rec?.crossSigning?.master;
		return master !== void 0 && rec?.trust?.verifiedMaster === publicKeyOf(master);
	}
	async deviceTrust(userId, deviceId) {
		const rec = await this.devices.getUser(userId);
		const device = rec?.devices[deviceId];
		if (!device) return {
			locallyVerified: false,
			crossSigned: false,
			verified: false
		};
		const locallyVerified = rec?.trust?.verifiedDevices?.includes(device.ed25519) ?? false;
		let crossSigned = false;
		const ssk = rec?.crossSigning?.selfSigning;
		const sskPub = ssk ? publicKeyOf(ssk) : void 0;
		if (sskPub && device.signed && verifyObject(this.protocol, device.signed, userId, sskPub, sskPub)) crossSigned = (await this.userTrust(userId)).verified;
		const self = userId === this.userId && deviceId === this.deviceId;
		return {
			locallyVerified: locallyVerified || self,
			crossSigned,
			verified: locallyVerified || crossSigned || self
		};
	}
	/** Accept a user's new identity (master key) after showing the change: it becomes the pinned one. */
	async acceptIdentityChange(userId) {
		const master = (await this.devices.getUser(userId))?.crossSigning?.master;
		if (master) await this.devices.updateTrust(userId, (t) => ({
			...t,
			pinnedMaster: publicKeyOf(master)
		}));
	}
	/** Mark a device verified on this device (after SAS or QR). */
	async setDeviceVerified(userId, deviceId, verified = true) {
		const device = (await this.devices.getUser(userId))?.devices[deviceId];
		if (!device) throw new Error("Unknown device");
		await this.devices.updateTrust(userId, (t) => {
			const set = new Set(t.verifiedDevices ?? []);
			if (verified) set.add(device.ed25519);
			else set.delete(device.ed25519);
			return {
				...t,
				verifiedDevices: [...set]
			};
		});
	}
	/** Sign one of our own devices with our self-signing key (so our other devices and contacts trust it). */
	async signOwnDevice(deviceId) {
		const { selfSigning } = await this.privateKeys();
		if (!selfSigning) throw new Error("This device does not have the self-signing key");
		const pub = encodeBase64(this.primitives.ed25519PublicKey(selfSigning));
		const device = deviceId === this.deviceId ? await this.ownDeviceKeys() : (await this.devices.getUser(this.userId))?.devices[deviceId]?.signed;
		if (!device) throw new Error("Unknown device");
		await this.uploadSignatures({ [this.userId]: { [deviceId]: this.sign(selfSigning, pub, device) } });
		await this.devices.refresh([this.userId], { force: true });
	}
	/**
	* Verify another user: sign their master key with our user-signing key, which makes every
	* device they sign trusted here and on our other devices. `expectedMasterKey` pins the key
	* seen during the verification (the spec requires the keys not to change during it).
	*/
	async verifyUser(userId, expectedMasterKey) {
		const { userSigning } = await this.privateKeys();
		if (!userSigning) throw new Error("This device does not have the user-signing key");
		const master = (await this.devices.getUser(userId))?.crossSigning?.master;
		const mpk = master ? publicKeyOf(master) : void 0;
		if (!master || !mpk) throw new Error("The user has no cross-signing keys");
		if (expectedMasterKey !== void 0 && expectedMasterKey !== mpk) throw new Error("The user's master key changed during the verification");
		const pub = encodeBase64(this.primitives.ed25519PublicKey(userSigning));
		const { signatures: _theirs, ...unsigned } = master;
		await this.uploadSignatures({ [userId]: { [mpk]: this.sign(userSigning, pub, unsigned) } });
		await this.devices.updateTrust(userId, (t) => ({
			...t,
			verifiedMaster: mpk,
			pinnedMaster: mpk
		}));
		await this.devices.refresh([userId], { force: true });
	}
	/** A user's master key, if any (for verification: their identity as a "device"). */
	async masterKey(userId) {
		const master = (await this.devices.getUser(userId))?.crossSigning?.master;
		return master ? publicKeyOf(master) : void 0;
	}
};
/** Decode a cross-signing seed sent as a secret (unpadded base64), checking its length. */
function seedFromSecret(secret) {
	const seed = decodeBase64(secret);
	if (seed.length !== 32) throw new Error("A cross-signing key must be 32 bytes");
	return seed;
}
export { CrossSigning, seedFromSecret };

//# sourceMappingURL=cross-signing.js.map