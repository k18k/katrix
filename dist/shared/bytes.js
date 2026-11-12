// ../shared/src/bytes.ts
function concatBytes(...parts) {
	let length = 0;
	for (const p of parts) length += p.length;
	const out = new Uint8Array(length);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
/**
* Compares without an early exit, so the time taken does not tell how many leading bytes of a MAC
* matched. (A JavaScript engine gives no hard guarantee, but nothing here branches on the data.)
*/
function constantTimeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}
function bytesEqual(a, b) {
	return constantTimeEqual(a, b);
}
function writeUint32BE(value, out, offset) {
	out[offset] = value >>> 24 & 255;
	out[offset + 1] = value >>> 16 & 255;
	out[offset + 2] = value >>> 8 & 255;
	out[offset + 3] = value & 255;
}
function readUint32BE(bytes, offset) {
	return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
}
export { bytesEqual, concatBytes, constantTimeEqual, readUint32BE, writeUint32BE };

//# sourceMappingURL=bytes.js.map