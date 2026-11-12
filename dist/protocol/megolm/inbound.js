import { decodeBase64, encodeBase64 } from "../../shared/base64.js";
import { bytesEqual, constantTimeEqual } from "../../shared/bytes.js";
import { ProtocolError } from "../protocol.js";
import { b64, field, readPickle, writePickle } from "../pickle.js";
import { decodeMessage } from "./message.js";
import { advanceTo, copyRatchet, messageKeys, ratchetBytes, ratchetFromBytes } from "./ratchet.js";
import { decodeExport, decodeSessionKey, encodeExport } from "./session-key.js";
// src/protocol/megolm/inbound.ts
/**
* An inbound Megolm session. It keeps the ratchet at the first known index (to decrypt any later
* message, in any order) and the latest one it reached (so decrypting in order costs one step).
*/
var NativeInboundGroupSession = class NativeInboundGroupSession {
	p;
	initial;
	latest;
	signingKey;
	signingKeyVerified;
	constructor(p, initial, latest, signingKey, verified) {
		this.p = p;
		this.initial = initial;
		this.latest = latest;
		this.signingKey = signingKey;
		this.signingKeyVerified = verified;
	}
	static fromSessionKey(p, sessionKey) {
		const { ratchet, signingKey } = decodeSessionKey(p, sessionKey);
		return new NativeInboundGroupSession(p, ratchet, copyRatchet(ratchet), signingKey, true);
	}
	static fromExport(p, exported) {
		const { ratchet, signingKey } = decodeExport(exported);
		return new NativeInboundGroupSession(p, ratchet, copyRatchet(ratchet), signingKey, false);
	}
	sessionId() {
		return encodeBase64(this.signingKey);
	}
	firstKnownIndex() {
		return this.initial.counter;
	}
	isSigningKeyVerified() {
		return this.signingKeyVerified;
	}
	/** The ratchet at `index`, from the closest known state at or before it. */
	ratchetAt(index) {
		if (index < this.initial.counter) return void 0;
		const r = copyRatchet(this.latest.counter <= index ? this.latest : this.initial);
		advanceTo(this.p, r, index);
		return r;
	}
	decrypt(ciphertext) {
		let bytes;
		try {
			bytes = decodeBase64(ciphertext);
		} catch {
			throw new ProtocolError("BAD_MESSAGE_FORMAT", "Ciphertext is not Base64");
		}
		const m = decodeMessage(bytes);
		if (!this.p.ed25519Verify(this.signingKey, m.signatureInput, m.signature)) throw new ProtocolError("BAD_SIGNATURE", "Megolm message signature does not verify");
		const r = this.ratchetAt(m.index);
		if (!r) throw new ProtocolError("UNKNOWN_MESSAGE_INDEX", "The session does not know this message index");
		const keys = messageKeys(this.p, r);
		if (!constantTimeEqual(this.p.hmacSha256(keys.mac, m.macInput).subarray(0, m.mac.length), m.mac)) throw new ProtocolError("BAD_MESSAGE_MAC", "Megolm message MAC does not match");
		let plaintext;
		try {
			plaintext = this.p.aes256CbcDecrypt(keys.aes, keys.iv, m.ciphertext);
		} catch {
			throw new ProtocolError("BAD_DECRYPTION", "Megolm message does not decrypt");
		}
		if (r.counter > this.latest.counter) this.latest = r;
		return {
			plaintext,
			messageIndex: m.index
		};
	}
	exportAt(index) {
		const r = this.ratchetAt(index);
		return r ? encodeExport(r, this.signingKey) : void 0;
	}
	compare(other) {
		if (other.sessionId() !== this.sessionId()) return "unconnected";
		const theirIndex = other.firstKnownIndex();
		const mine = this.initial.counter;
		const at = Math.max(mine, theirIndex);
		const a = this.exportAt(at);
		const b = other.exportAt(at);
		if (!a || !b || a !== b) return "unconnected";
		return mine < theirIndex ? "better" : mine === theirIndex ? "equal" : "worse";
	}
	pickle(key) {
		return writePickle(this.p, "megolm_inbound", {
			initial: b64(ratchetBytes(this.initial)),
			initial_counter: this.initial.counter,
			latest: b64(ratchetBytes(this.latest)),
			latest_counter: this.latest.counter,
			signing_key: b64(this.signingKey),
			signing_key_verified: this.signingKeyVerified
		}, key);
	}
	static fromPickle(p, pickle, key) {
		const s = readPickle(p, "megolm_inbound", pickle, key);
		const initial = ratchetFromBytes(field.bytes(s, "initial", 128), field.uint(s, "initial_counter"));
		const latest = ratchetFromBytes(field.bytes(s, "latest", 128), field.uint(s, "latest_counter"));
		if (latest.counter < initial.counter) throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
		const signingKey = field.bytes(s, "signing_key", 32);
		const check = copyRatchet(initial);
		advanceTo(p, check, latest.counter);
		if (!bytesEqual(ratchetBytes(check), ratchetBytes(latest))) throw new ProtocolError("BAD_PICKLE", "Corrupted pickle");
		return new NativeInboundGroupSession(p, initial, latest, signingKey, field.bool(s, "signing_key_verified"));
	}
};
export { NativeInboundGroupSession };

//# sourceMappingURL=inbound.js.map