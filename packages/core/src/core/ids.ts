import { randomString } from "#core/crypto.ts";

export const LOCALPART_RE = /^[a-z0-9._=\-/+]+$/;

export function parseId(id: string, sigil: string): { localpart: string; server: string } | null {
  if (typeof id !== "string" || !id.startsWith(sigil)) return null;
  const idx = id.indexOf(":");
  if (idx < 2) return null;
  return { localpart: id.slice(1, idx), server: id.slice(idx + 1) };
}

/** Server name grammar: DNS name, IPv4 or bracketed IPv6, with an optional port. */
const SERVER_NAME_RE = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;

export function isValidServerName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && SERVER_NAME_RE.test(name);
}

export function isValidUserId(id: unknown): id is string {
  if (typeof id !== "string" || id.length > 255) return false;
  const parsed = parseId(id, "@");
  return !!parsed && isValidServerName(parsed.server);
}

export function isValidRoomId(id: unknown): id is string {
  // Room version 12 IDs ("!<hash>") have no server name.
  return typeof id === "string" && /^![^\s:]+(:[^\s]+)?$/.test(id);
}

export function isValidAlias(id: unknown): id is string {
  return typeof id === "string" && id.length <= 255 && !!parseId(id, "#");
}

export function generateRoomId(serverName: string): string {
  return `!${randomString(18)}:${serverName}`;
}

export function generateDeviceId(): string {
  return randomString(10).toUpperCase();
}
