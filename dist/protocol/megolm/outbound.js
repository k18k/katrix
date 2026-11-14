import { concatBytes } from "../../shared/bytes.js";
import { encodeBase64 } from "../../shared/base64.js";
import { b64, field, readPickle, writePickle } from "../pickle.js";
import { encodeBody } from "./message.js";
import { advance, messageKeys, ratchetBytes, ratchetFromBytes } from "./ratchet.js";
import { encodeSessionKey } from "./session-key.js";
// src/protocol/megolm/outbound.ts
var NativeOutboundGroupSession = class NativeOutboundGroupSession {
	p;
	ratchet;
	signing;
	constructor(p, ratchet, signing) {
		this.p = p;
		this.ratchet = ratchet;
		this.signing = signing;
	}
	/** A fresh session: random ratchet at index 0 and a new Ed25519 key, whose public half is the ID. */
	static create(p) {
		return new NativeOutboundGroupSession(p, ratchetFromBytes(p.randomBytes(128), 0), p.ed25519GenerateKeyPair());
	}
	sessionId() {
		return encodeBase64(this.signing.publicKey);
	}
	messageIndex() {
		return this.ratchet.counter;
	}
	sessionKey() {
		return encodeSessionKey(this.p, this.ratchet, this.signing);
	}
	encrypt(plaintext) {
		const keys = messageKeys(this.p, this.ratchet);
		const ciphertext = this.p.aes256CbcEncrypt(keys.aes, keys.iv, plaintext);
		const body = encodeBody(this.ratchet.counter, ciphertext);
		const authenticated = concatBytes(body, this.p.hmacSha256(keys.mac, body).subarray(0, 8));
		const signature = this.p.ed25519Sign(this.signing.secretKey, authenticated);
		advance(this.p, this.ratchet);
		return encodeBase64(concatBytes(authenticated, signature));
	}
	pickle(key) {
		return writePickle(this.p, "megolm_outbound", {
			ratchet: b64(ratchetBytes(this.ratchet)),
			counter: this.ratchet.counter,
			signing_secret_key: b64(this.signing.secretKey),
			signing_public_key: b64(this.signing.publicKey)
		}, key);
	}
	static fromPickle(p, pickle, key) {
		const s = readPickle(p, "megolm_outbound", pickle, key);
		return new NativeOutboundGroupSession(p, ratchetFromBytes(field.bytes(s, "ratchet", 128), field.uint(s, "counter")), {
			secretKey: field.bytes(s, "signing_secret_key", 32),
			publicKey: field.bytes(s, "signing_public_key", 32)
		});
	}
};
export { NativeOutboundGroupSession };

//# sourceMappingURL=outbound.js.map