// ../shared/src/utf8.ts
/**
* UTF-8 without TextEncoder/TextDecoder: Hermes has no TextDecoder, and decrypted plaintexts must
* be decoded strictly (invalid UTF-8 is an error, not U+FFFD), which TextDecoder only does with
* `fatal: true` anyway.
*/
function encodeUtf8(s) {
	const out = [];
	for (let i = 0; i < s.length; i++) {
		let c = s.charCodeAt(i);
		if (c >= 55296 && c <= 56319 && i + 1 < s.length) {
			const d = s.charCodeAt(i + 1);
			if (d >= 56320 && d <= 57343) {
				c = 65536 + (c - 55296 << 10) + (d - 56320);
				i++;
			}
		}
		if (c >= 55296 && c <= 57343) c = 65533;
		if (c < 128) out.push(c);
		else if (c < 2048) out.push(192 | c >> 6, 128 | c & 63);
		else if (c < 65536) out.push(224 | c >> 12, 128 | c >> 6 & 63, 128 | c & 63);
		else out.push(240 | c >> 18, 128 | c >> 12 & 63, 128 | c >> 6 & 63, 128 | c & 63);
	}
	return Uint8Array.from(out);
}
var Utf8Error = class extends Error {
	constructor() {
		super("Invalid UTF-8");
		this.name = "Utf8Error";
	}
};
/** Strict decoding: overlong forms, surrogates, code points above U+10FFFF and truncation throw. */
function decodeUtf8(bytes) {
	let out = "";
	const chunk = [];
	for (let i = 0; i < bytes.length;) {
		const b = bytes[i];
		let cp, n, min;
		if (b < 128) {
			cp = b;
			n = 0;
			min = 0;
		} else if ((b & 224) === 192) {
			cp = b & 31;
			n = 1;
			min = 128;
		} else if ((b & 240) === 224) {
			cp = b & 15;
			n = 2;
			min = 2048;
		} else if ((b & 248) === 240) {
			cp = b & 7;
			n = 3;
			min = 65536;
		} else throw new Utf8Error();
		for (let k = 1; k <= n; k++) {
			const c = bytes[i + k];
			if (c === void 0 || (c & 192) !== 128) throw new Utf8Error();
			cp = cp << 6 | c & 63;
		}
		if (cp < min || cp > 1114111 || cp >= 55296 && cp <= 57343) throw new Utf8Error();
		i += n + 1;
		if (cp >= 65536) {
			cp -= 65536;
			chunk.push(55296 + (cp >> 10), 56320 + (cp & 1023));
		} else chunk.push(cp);
		if (chunk.length >= 4096) {
			out += String.fromCharCode(...chunk);
			chunk.length = 0;
		}
	}
	return out + String.fromCharCode(...chunk);
}
export { Utf8Error, decodeUtf8, encodeUtf8 };

//# sourceMappingURL=utf8.js.map