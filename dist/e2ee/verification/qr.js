import { concatBytes } from "../../shared/bytes.js";
import { decodeUtf8, encodeUtf8 } from "../../shared/utf8.js";
// src/e2ee/verification/qr.ts
const QR_SHOW = "m.qr_code.show.v1";
const QR_SCAN = "m.qr_code.scan.v1";
const RECIPROCATE = "m.reciprocate.v1";
const PREFIX = encodeUtf8("MATRIX");
function encodeQr(d) {
	if (d.firstKey.length !== 32 || d.secondKey.length !== 32) throw new Error("QR code keys are 32 bytes");
	const id = encodeUtf8(d.transactionId);
	if (id.length > 65535) throw new Error("Transaction ID too long");
	return concatBytes(PREFIX, new Uint8Array([
		2,
		d.mode,
		id.length >> 8,
		id.length & 255
	]), id, d.firstKey, d.secondKey, d.secret);
}
/** Parse a scanned code; throws if it is not a Matrix verification code of version 2. */
function decodeQr(bytes) {
	if (bytes.length < 10 || !PREFIX.every((b, i) => bytes[i] === b)) throw new Error("Not a Matrix verification QR code");
	if (bytes[6] !== 2) throw new Error("Unsupported QR code version");
	const mode = bytes[7];
	if (mode !== 0 && mode !== 1 && mode !== 2) throw new Error("Unknown QR code mode");
	const keysAt = 10 + (bytes[8] << 8 | bytes[9]);
	if (bytes.length < keysAt + 64 + 8) throw new Error("QR code too short");
	return {
		mode,
		transactionId: decodeUtf8(bytes.subarray(10, keysAt)),
		firstKey: bytes.slice(keysAt, keysAt + 32),
		secondKey: bytes.slice(keysAt + 32, keysAt + 64),
		secret: bytes.slice(keysAt + 64)
	};
}
export { QR_SCAN, QR_SHOW, RECIPROCATE, decodeQr, encodeQr };

//# sourceMappingURL=qr.js.map