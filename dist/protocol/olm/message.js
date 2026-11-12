import { concatBytes } from "../../shared/bytes.js";
import { ProtocolError } from "../protocol.js";
import { WireWriter, bytesField, intField, readFields } from "../wire.js";
const T_RATCHET_KEY = 10;
const T_CHAIN_INDEX = 16;
const T_CIPHERTEXT = 34;
const T_ONE_TIME_KEY = 10;
const T_BASE_KEY = 18;
const T_IDENTITY_KEY = 26;
const T_MESSAGE = 34;
/** The normal message without its MAC; the caller appends HMAC(authenticated)[0..8]. */
function encodeNormalBody(ratchetKey, chainIndex, ciphertext) {
	return new WireWriter().byte(3).bytesField(T_RATCHET_KEY, ratchetKey).varintField(T_CHAIN_INDEX, chainIndex).bytesField(T_CIPHERTEXT, ciphertext).finish();
}
function decodeNormal(bytes) {
	if (bytes.length < 1) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Empty message");
	if (bytes[0] !== 3) throw new ProtocolError("BAD_MESSAGE_VERSION", "Unsupported Olm message version");
	if (bytes.length < 9) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Truncated message");
	const authenticated = bytes.subarray(0, bytes.length - 8);
	const fields = readFields(authenticated.subarray(1));
	const ratchetKey = bytesField(fields, T_RATCHET_KEY, 32);
	const chainIndex = intField(fields, T_CHAIN_INDEX);
	const ciphertext = bytesField(fields, T_CIPHERTEXT);
	if (!ratchetKey || chainIndex === void 0 || !ciphertext) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Missing message fields");
	return {
		ratchetKey,
		chainIndex,
		ciphertext,
		authenticated,
		mac: bytes.slice(bytes.length - 8)
	};
}
function encodePreKey(m) {
	return new WireWriter().byte(3).bytesField(T_ONE_TIME_KEY, m.oneTimeKey).bytesField(T_BASE_KEY, m.baseKey).bytesField(T_IDENTITY_KEY, m.identityKey).bytesField(T_MESSAGE, m.message).finish();
}
function decodePreKey(bytes) {
	if (bytes.length < 1) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Empty message");
	if (bytes[0] !== 3) throw new ProtocolError("BAD_MESSAGE_VERSION", "Unsupported Olm message version");
	const fields = readFields(bytes.subarray(1));
	const oneTimeKey = bytesField(fields, T_ONE_TIME_KEY, 32);
	const baseKey = bytesField(fields, T_BASE_KEY, 32);
	const identityKey = bytesField(fields, T_IDENTITY_KEY, 32);
	const message = bytesField(fields, T_MESSAGE);
	if (!oneTimeKey || !baseKey || !message) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Missing pre-key message fields");
	return {
		oneTimeKey,
		baseKey,
		identityKey,
		message
	};
}
function withMac(authenticated, mac) {
	return concatBytes(authenticated, mac.subarray(0, 8));
}
export { decodeNormal, decodePreKey, encodeNormalBody, encodePreKey, withMac };

//# sourceMappingURL=message.js.map