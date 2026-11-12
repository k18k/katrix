import { randomString } from "#core/crypto.ts";

// The identifier checks (parseId, isValidUserId, …) live in @katrix/shared (packages/shared).

export function generateRoomId(serverName: string): string {
  return `!${randomString(18)}:${serverName}`;
}

export function generateDeviceId(): string {
  return randomString(10).toUpperCase();
}
