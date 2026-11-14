// Canonical JSON and isObject live in @katrix/shared (packages/shared), shared with the client.

export function clone<T>(value: T) {
  return structuredClone(value);
}
