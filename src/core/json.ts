// https://github.com/k18k/matrix-nodejs-homeserver/issues/25: keys were sorted by UTF-16 code unit
// (the default sort), but the spec orders them by Unicode code point. The orders differ for
// characters outside the Basic Multilingual Plane, and then hashes and signatures did not match
// other servers'.
function byCodePoint(a: string, b: string): number {
  for (let i = 0; i < a.length && i < b.length;) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(i)!;
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

/** Matrix canonical JSON: sorted keys, no whitespace, UTF-8, integers only. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isInteger(value)) {
      throw new Error("Canonical JSON does not allow non-integer numbers");
    }
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort(byCodePoint);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
