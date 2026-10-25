/**
 * UTF-8 without TextEncoder/TextDecoder: Hermes has no TextDecoder, and decrypted plaintexts must
 * be decoded strictly (invalid UTF-8 is an error, not U+FFFD), which TextDecoder only does with
 * `fatal: true` anyway.
 */

export function encodeUtf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    // A lone surrogate becomes U+FFFD, as TextEncoder does.
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

export class Utf8Error extends Error {
  constructor() {
    super("Invalid UTF-8");
    this.name = "Utf8Error";
  }
}

/** Strict decoding: overlong forms, surrogates, code points above U+10FFFF and truncation throw. */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = "";
  const chunk: number[] = [];
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let cp: number, n: number, min: number;
    if (b < 0x80) {
      cp = b;
      n = 0;
      min = 0;
    } else if ((b & 0xe0) === 0xc0) {
      cp = b & 0x1f;
      n = 1;
      min = 0x80;
    } else if ((b & 0xf0) === 0xe0) {
      cp = b & 0x0f;
      n = 2;
      min = 0x800;
    } else if ((b & 0xf8) === 0xf0) {
      cp = b & 0x07;
      n = 3;
      min = 0x10000;
    } else throw new Utf8Error();
    // A truncated sequence reads `undefined` and fails the continuation-byte check.
    for (let k = 1; k <= n; k++) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) throw new Utf8Error();
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new Utf8Error();
    i += n + 1;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else chunk.push(cp);
    if (chunk.length >= 4096) {
      out += String.fromCharCode(...chunk);
      chunk.length = 0;
    }
  }
  return out + String.fromCharCode(...chunk);
}
