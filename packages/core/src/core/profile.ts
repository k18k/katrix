import { canonicalJson } from "#core/json.ts";
import type { Homeserver } from "#homeserver.ts";

// Extended profiles (spec v1.16): arbitrary JSON fields next to displayname/avatar_url.
// Every change is also recorded in `profile_fields` with a stream position (null = cleared),
// which is what sync uses for MSC4429 profile updates.

export const BUILTIN_FIELDS = new Set(["displayname", "avatar_url"]);
export const MAX_PROFILE_BYTES = 65536;
export const MAX_KEY_BYTES = 255;

export async function fullProfile(hs: Homeserver, userId: string): Promise<Record<string, unknown> | null> {
  const user = await hs.db.findOne("users", [{ field: "user_id", value: userId }]);
  if (!user || user.deactivated) return null;
  const out: Record<string, unknown> = {};
  for (const row of await hs.db.findMany("profile_fields", { where: [{ field: "user_id", value: userId }] })) {
    if (row.value !== null && row.value !== undefined && !BUILTIN_FIELDS.has(row.field)) out[row.field] = row.value;
  }
  if (user.displayname) out.displayname = user.displayname;
  if (user.avatar_url) out.avatar_url = user.avatar_url;
  return out;
}

export function profileSize(profile: Record<string, unknown>): number {
  return Buffer.byteLength(canonicalJson(profile));
}

/** Set (or with `null`, clear) one profile field and notify users sharing a room. */
export async function setProfileField(hs: Homeserver, userId: string, field: string, value: unknown): Promise<void> {
  if (BUILTIN_FIELDS.has(field)) {
    await hs.db.update("users", [{ field: "user_id", value: userId }], { [field]: value || null });
  }
  await hs.streams.write((stream) => hs.db.upsert("profile_fields", { user_id: userId, field, value: value ?? null, stream }));
  if (BUILTIN_FIELDS.has(field)) await hs.rooms.propagateProfile(userId);
  hs.notifier.notify([...(await hs.rooms.usersSharingRooms(userId))]);
}
