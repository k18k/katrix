/**
 * Canonical JSON (https://spec.matrix.org/v1.16/appendices/#canonical-json): keys sorted by
 * Unicode code point, no insignificant whitespace, integers only, in [-(2^53)+1, 2^53-1].
 * It is what Ed25519 signatures over JSON (device keys, one-time keys) cover.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/**
 * Sort by code point, not by UTF-16 code unit as Array.prototype.sort does: the two differ when
 * one key has a character above U+FFFF (a surrogate pair, 0xD800…) and the other one in
 * U+E000…U+FFFF.
 */
function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx - cy;
  }
}

const MAX_SAFE = 2 ** 53 - 1;

function write(value: unknown, out: string[]): void {
  if (value === null) {
    out.push("null");
  } else if (typeof value === "boolean") {
    out.push(value ? "true" : "false");
  } else if (typeof value === "number") {
    if (!Number.isInteger(value) || Math.abs(value) > MAX_SAFE) throw new CanonicalJsonError("Canonical JSON allows only safe integers");
    // -0 is written as 0 (the appendix's example).
    out.push(String(value === 0 ? 0 : value));
  } else if (typeof value === "string") {
    // JSON.stringify escapes exactly `"`, `\` and control characters (as \b \f \n \r \t or
    // \u00xx in lowercase hex), the canonical form.
    out.push(JSON.stringify(value));
  } else if (Array.isArray(value)) {
    out.push("[");
    value.forEach((v, i) => {
      if (i > 0) out.push(",");
      write(v === undefined ? null : v, out);
    });
    out.push("]");
  } else if (typeof value === "object") {
    const keys = Object.keys(value as object)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort(compareCodePoints);
    out.push("{");
    keys.forEach((k, i) => {
      if (i > 0) out.push(",");
      out.push(JSON.stringify(k), ":");
      write((value as Record<string, unknown>)[k], out);
    });
    out.push("}");
  } else {
    throw new CanonicalJsonError(`Canonical JSON cannot encode a ${typeof value}`);
  }
}

export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, out);
  return out.join("");
}

/** The canonical JSON that a signature covers: the object without `signatures` and `unsigned`. */
export function signingJson(value: Record<string, unknown>): string {
  const { signatures: _s, unsigned: _u, ...rest } = value;
  return canonicalJson(rest);
}
