import { ProtocolError } from "../protocol.js";
import { WireWriter, bytesField, intField, readFields } from "../wire.js";
const T_INDEX = 8;
const T_CIPHERTEXT = 18;
function encodeBody(index, ciphertext) {
	return new WireWriter().byte(3).varintField(T_INDEX, index).bytesField(T_CIPHERTEXT, ciphertext).finish();
}
function decodeMessage(bytes) {
	if (bytes.length < 1) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Empty message");
	if (bytes[0] !== 3) throw new ProtocolError("BAD_MESSAGE_VERSION", "Unsupported Megolm message version");
	if (bytes.length < 73) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Truncated message");
	const sigAt = bytes.length - 64;
	const macAt = sigAt - 8;
	const fields = readFields(bytes.subarray(1, macAt));
	const index = intField(fields, T_INDEX);
	const ciphertext = bytesField(fields, T_CIPHERTEXT);
	if (index === void 0 || !ciphertext) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Missing message fields");
	return {
		index,
		ciphertext,
		macInput: bytes.subarray(0, macAt),
		mac: bytes.slice(macAt, sigAt),
		signatureInput: bytes.subarray(0, sigAt),
		signature: bytes.slice(sigAt)
	};
}
export { decodeMessage, encodeBody };

//# sourceMappingURL=message.js.map