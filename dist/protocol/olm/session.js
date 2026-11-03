import { decodeBase64, encodeBase64 } from "../../util/base64.js";
import { bytesEqual, concatBytes } from "../../util/bytes.js";
import { b64, field, readPickle, writePickle } from "../pickle.js";
import { ProtocolError } from "../protocol.js";
import { decodePreKey, encodePreKey } from "./message.js";
import { ratchetDecrypt, ratchetEncrypt, ratchetFromJson, ratchetToJson } from "./ratchet.js";
export class NativeOlmSession {
    p;
    keys;
    ratchet;
    receivedMessage;
    constructor(p, keys, ratchet, receivedMessage) {
        this.p = p;
        this.keys = keys;
        this.ratchet = ratchet;
        this.receivedMessage = receivedMessage;
    }
    /** As libolm and vodozemac: SHA-256(Alice's identity key ‖ Alice's base key ‖ Bob's one-time key). */
    sessionId() {
        return encodeBase64(this.p.sha256(concatBytes(this.keys.aliceIdentityKey, this.keys.aliceBaseKey, this.keys.bobOneTimeKey)));
    }
    hasReceivedMessage() {
        return this.receivedMessage;
    }
    encrypt(plaintext) {
        const message = ratchetEncrypt(this.p, this.ratchet, plaintext);
        if (this.receivedMessage)
            return { type: 1, body: encodeBase64(message) };
        // Until the other side answers, every message carries what it needs to create the session.
        const preKey = encodePreKey({
            oneTimeKey: this.keys.bobOneTimeKey,
            baseKey: this.keys.aliceBaseKey,
            identityKey: this.keys.aliceIdentityKey,
            message,
        });
        return { type: 0, body: encodeBase64(preKey) };
    }
    decrypt(message) {
        const bytes = decodeBody(message);
        let inner;
        if (message.type === 0) {
            const preKey = decodePreKey(bytes);
            if (!this.matchesPreKey(preKey))
                throw new ProtocolError("SESSION_MISMATCH", "Pre-key message is for another session");
            inner = preKey.message;
        }
        else if (message.type === 1) {
            inner = bytes;
        }
        else {
            throw new ProtocolError("BAD_MESSAGE_FORMAT", "Unknown Olm message type");
        }
        const { state, plaintext } = ratchetDecrypt(this.p, this.ratchet, inner);
        this.ratchet = state;
        this.receivedMessage = true;
        return plaintext;
    }
    sessionMatches(message) {
        if (message.type !== 0)
            return false;
        try {
            return this.matchesPreKey(decodePreKey(decodeBody(message)));
        }
        catch {
            return false;
        }
    }
    matchesPreKey(m) {
        return (bytesEqual(m.oneTimeKey, this.keys.bobOneTimeKey) &&
            bytesEqual(m.baseKey, this.keys.aliceBaseKey) &&
            (m.identityKey === undefined || bytesEqual(m.identityKey, this.keys.aliceIdentityKey)));
    }
    pickle(key) {
        return writePickle(this.p, "olm_session", {
            alice_identity_key: b64(this.keys.aliceIdentityKey),
            alice_base_key: b64(this.keys.aliceBaseKey),
            bob_one_time_key: b64(this.keys.bobOneTimeKey),
            received_message: this.receivedMessage,
            ratchet: ratchetToJson(this.ratchet),
        }, key);
    }
    static fromPickle(p, pickle, key) {
        const s = readPickle(p, "olm_session", pickle, key);
        return new NativeOlmSession(p, {
            aliceIdentityKey: field.bytes(s, "alice_identity_key", 32),
            aliceBaseKey: field.bytes(s, "alice_base_key", 32),
            bobOneTimeKey: field.bytes(s, "bob_one_time_key", 32),
        }, ratchetFromJson(field.optional(s, "ratchet") ?? {}), field.bool(s, "received_message"));
    }
}
export function decodeBody(message) {
    if (typeof message?.body !== "string")
        throw new ProtocolError("BAD_MESSAGE_FORMAT", "Missing message body");
    try {
        return decodeBase64(message.body);
    }
    catch {
        throw new ProtocolError("BAD_MESSAGE_FORMAT", "Message body is not Base64");
    }
}
