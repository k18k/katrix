export function concatBytes(...parts) {
    let length = 0;
    for (const p of parts)
        length += p.length;
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
export function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a[i] ^ b[i];
    return diff === 0;
}
export function bytesEqual(a, b) {
    return constantTimeEqual(a, b);
}
export function writeUint32BE(value, out, offset) {
    out[offset] = (value >>> 24) & 0xff;
    out[offset + 1] = (value >>> 16) & 0xff;
    out[offset + 2] = (value >>> 8) & 0xff;
    out[offset + 3] = value & 0xff;
}
export function readUint32BE(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}
export function toHex(bytes) {
    let s = "";
    for (const b of bytes)
        s += b.toString(16).padStart(2, "0");
    return s;
}
export function fromHex(hex) {
    if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex))
        throw new Error("Invalid hex");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}
