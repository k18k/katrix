// https://github.com/k18k/katrix/issues/128: this guard narrowed to Record<string, any>, so every field read from untrusted JSON was unchecked
// any; fields are unknown now and need their own check.
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringOrUndefined(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((v) => typeof v === "string");
}
