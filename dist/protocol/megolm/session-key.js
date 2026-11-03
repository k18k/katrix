import { decodeBase64, encodeBase64 } from "../../util/base64.js";
import { concatBytes, readUint32BE, writeUint32BE } from "../../util/bytes.js";
import { ProtocolError } from "../protocol.js";
import { ratchetBytes, ratchetFromBytes, RATCHET_LENGTH } from "./ratchet.js";
/**
 * Session sharing (megolm.md, "Session-sharing format"), the m.room_key `session_key`:
 *   0x02 | index (u32 BE) | R_0…R_3 (128) | Ed25519 public key (32) | signature (64)  = 229 bytes
 * and the export format (m.forwarded_room_key, key backup), the same without the signature:
 *   0x01 | index (u32 BE) | R_0…R_3 (128) | Ed25519 public key (32)                  = 165 bytes
 */
const SHARE_VERSION = 0x02;
const EXPORT_VERSION = 0x01;
const BODY_LENGTH = 1 + 4 + RATCHET_LENGTH + 32;
function body(version, r, signingKey) {
    const out = new Uint8Array(BODY_LENGTH);
    out[0] = version;
    writeUint32BE(r.counter, out, 1);
    out.set(ratchetBytes(r), 5);
    out.set(signingKey, 5 + RATCHET_LENGTH);
    return out;
}
export function encodeSessionKey(p, r, signing) {
    const b = body(SHARE_VERSION, r, signing.publicKey);
    return encodeBase64(concatBytes(b, p.ed25519Sign(signing.secretKey, b)));
}
export function encodeExport(r, signingKey) {
    return encodeBase64(body(EXPORT_VERSION, r, signingKey));
}
function decode(input) {
    try {
        return decodeBase64(input);
    }
    catch {
        throw new ProtocolError("BAD_SESSION_KEY", "Session key is not Base64");
    }
}
function parts(bytes) {
    return {
        ratchet: ratchetFromBytes(bytes.subarray(5, 5 + RATCHET_LENGTH), readUint32BE(bytes, 1)),
        signingKey: bytes.slice(5 + RATCHET_LENGTH, BODY_LENGTH),
    };
}
export function decodeSessionKey(p, input) {
    const bytes = decode(input);
    if (bytes.length !== BODY_LENGTH + 64 || bytes[0] !== SHARE_VERSION)
        throw new ProtocolError("BAD_SESSION_KEY", "Not a Megolm session key");
    const { ratchet, signingKey } = parts(bytes);
    // The session key is signed by the session's own key: it proves the sender holds the key that
    // signs every message, so messages cannot be forged by whoever forwards the key.
    if (!p.ed25519Verify(signingKey, bytes.subarray(0, BODY_LENGTH), bytes.subarray(BODY_LENGTH))) {
        throw new ProtocolError("BAD_SIGNATURE", "Session key signature does not verify");
    }
    return { ratchet, signingKey };
}
export function decodeExport(input) {
    const bytes = decode(input);
    if (bytes.length !== BODY_LENGTH || bytes[0] !== EXPORT_VERSION)
        throw new ProtocolError("BAD_SESSION_KEY", "Not an exported Megolm session");
    return parts(bytes);
}
