import { bytesEqual, concatBytes, writeUint32BE } from "../../shared/bytes.js";
import { encodeBase64 } from "../../shared/base64.js";
import { encodeUtf8 } from "../../shared/utf8.js";
import { b64, decodeKey, field, readPickle, writePickle } from "../pickle.js";
import { ProtocolError } from "../protocol.js";
import { decodeNormal, decodePreKey } from "./message.js";
import { ecdh, initialiseAsAlice, initialiseAsBob } from "./ratchet.js";
import { NativeOlmSession, decodeBody } from "./session.js";
/** libolm's key ID format: the 32-bit counter, big-endian, unpadded Base64 ("AAAAAQ"). */
function keyIdString(id) {
	const b = /* @__PURE__ */ new Uint8Array(4);
	writeUint32BE(id, b, 0);
	return encodeBase64(b);
}
var NativeOlmAccount = class NativeOlmAccount {
	p;
	curve25519;
	ed25519;
	oneTime;
	nextKeyId;
	fallback;
	previousFallback;
	constructor(p, s) {
		this.p = p;
		this.curve25519 = s.curve25519;
		this.ed25519 = s.ed25519;
		this.oneTime = s.oneTime;
		this.nextKeyId = s.nextKeyId;
		this.fallback = s.fallback;
		this.previousFallback = s.previousFallback;
	}
	static create(p) {
		return new NativeOlmAccount(p, {
			curve25519: p.x25519GenerateKeyPair(),
			ed25519: p.ed25519GenerateKeyPair(),
			oneTime: [],
			nextKeyId: 1
		});
	}
	identityKeys() {
		return {
			curve25519: encodeBase64(this.curve25519.publicKey),
			ed25519: encodeBase64(this.ed25519.publicKey)
		};
	}
	sign(message) {
		return encodeBase64(this.p.ed25519Sign(this.ed25519.secretKey, encodeUtf8(message)));
	}
	maxNumberOfOneTimeKeys() {
		return 50;
	}
	generateOneTimeKeys(count) {
		for (let i = 0; i < count; i++) this.oneTime.push({
			id: this.nextKeyId++,
			key: this.p.x25519GenerateKeyPair(),
			published: false
		});
		if (this.oneTime.length > 100) this.oneTime.splice(0, this.oneTime.length - 100);
	}
	oneTimeKeys() {
		const out = {};
		for (const k of this.oneTime) if (!k.published) out[keyIdString(k.id)] = encodeBase64(k.key.publicKey);
		return out;
	}
	generateFallbackKey() {
		this.previousFallback = this.fallback;
		this.fallback = {
			id: this.nextKeyId++,
			key: this.p.x25519GenerateKeyPair(),
			published: false
		};
	}
	fallbackKey() {
		return this.fallback && !this.fallback.published ? { [keyIdString(this.fallback.id)]: encodeBase64(this.fallback.key.publicKey) } : {};
	}
	forgetFallbackKey() {
		const had = this.previousFallback !== void 0;
		this.previousFallback = void 0;
		return had;
	}
	markKeysAsPublished() {
		for (const k of this.oneTime) k.published = true;
		if (this.fallback) this.fallback.published = true;
	}
	createOutboundSession(identityKey, oneTimeKey) {
		const theirIdentity = decodeKey(identityKey, 32);
		const theirOneTime = decodeKey(oneTimeKey, 32);
		const base = this.p.x25519GenerateKeyPair();
		const ratchet = this.p.x25519GenerateKeyPair();
		const secret = concatBytes(ecdh(this.p, this.curve25519.secretKey, theirOneTime), ecdh(this.p, base.secretKey, theirIdentity), ecdh(this.p, base.secretKey, theirOneTime));
		return new NativeOlmSession(this.p, {
			aliceIdentityKey: this.curve25519.publicKey,
			aliceBaseKey: base.publicKey,
			bobOneTimeKey: theirOneTime
		}, initialiseAsAlice(this.p, secret, ratchet), false);
	}
	createInboundSession(theirIdentityKey, message) {
		if (message.type !== 0) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Only a pre-key message can start a session");
		const theirIdentity = decodeKey(theirIdentityKey, 32);
		const preKey = decodePreKey(decodeBody(message));
		if (preKey.identityKey && !bytesEqual(preKey.identityKey, theirIdentity)) throw new ProtocolError("SESSION_MISMATCH", "Pre-key message is from another identity key");
		const otk = this.findKey(preKey.oneTimeKey);
		if (!otk) throw new ProtocolError("UNKNOWN_ONE_TIME_KEY", "Pre-key message uses an unknown one-time key");
		const inner = decodeNormal(preKey.message);
		const secret = concatBytes(ecdh(this.p, otk.key.secretKey, theirIdentity), ecdh(this.p, this.curve25519.secretKey, preKey.baseKey), ecdh(this.p, otk.key.secretKey, preKey.baseKey));
		const session = new NativeOlmSession(this.p, {
			aliceIdentityKey: theirIdentity,
			aliceBaseKey: preKey.baseKey,
			bobOneTimeKey: otk.key.publicKey
		}, initialiseAsBob(this.p, secret, inner.ratchetKey), false);
		const plaintext = session.decrypt(message);
		if (otk !== this.fallback && otk !== this.previousFallback) this.oneTime = this.oneTime.filter((k) => k !== otk);
		return {
			session,
			plaintext
		};
	}
	findKey(publicKey) {
		return this.oneTime.find((k) => bytesEqual(k.key.publicKey, publicKey)) ?? [this.fallback, this.previousFallback].find((k) => k !== void 0 && bytesEqual(k.key.publicKey, publicKey));
	}
	pickle(key) {
		const keyJson = (k) => ({
			id: k.id,
			secret_key: b64(k.key.secretKey),
			public_key: b64(k.key.publicKey),
			published: k.published
		});
		return writePickle(this.p, "olm_account", {
			curve25519: {
				secret_key: b64(this.curve25519.secretKey),
				public_key: b64(this.curve25519.publicKey)
			},
			ed25519: {
				secret_key: b64(this.ed25519.secretKey),
				public_key: b64(this.ed25519.publicKey)
			},
			one_time_keys: this.oneTime.map(keyJson),
			next_key_id: this.nextKeyId,
			fallback: this.fallback ? keyJson(this.fallback) : null,
			previous_fallback: this.previousFallback ? keyJson(this.previousFallback) : null
		}, key);
	}
	static fromPickle(p, pickle, key) {
		const s = readPickle(p, "olm_account", pickle, key);
		const pair = (j) => {
			if (!j) throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
			return {
				secretKey: field.bytes(j, "secret_key", 32),
				publicKey: field.bytes(j, "public_key", 32)
			};
		};
		const otk = (j) => ({
			id: field.uint(j, "id"),
			key: pair(j),
			published: field.bool(j, "published")
		});
		const fallback = field.optional(s, "fallback");
		const previous = field.optional(s, "previous_fallback");
		const account = new NativeOlmAccount(p, {
			curve25519: pair(field.optional(s, "curve25519")),
			ed25519: pair(field.optional(s, "ed25519")),
			oneTime: field.array(s, "one_time_keys").map(otk),
			nextKeyId: field.uint(s, "next_key_id"),
			fallback: fallback ? otk(fallback) : void 0,
			previousFallback: previous ? otk(previous) : void 0
		});
		if (!bytesEqual(p.x25519PublicKey(account.curve25519.secretKey), account.curve25519.publicKey) || !bytesEqual(p.ed25519PublicKey(account.ed25519.secretKey), account.ed25519.publicKey)) throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
		return account;
	}
};
export { NativeOlmAccount };

//# sourceMappingURL=account.js.map