import { isObject, isValidUserId, M } from "@katrix/shared";
import { errors } from "#core/errors.ts";
import { SUPPORTED_ROOM_VERSIONS } from "#core/events.ts";

// https://github.com/k18k/katrix/issues/128: createRoom read its request as Record<string, any> and checked the initial
// state events only while sending them, after the room existed. The request is parsed here, in one place, before anything
// is created; past this point createRoom trusts its options.

const PRESETS = ["public_chat", "private_chat", "trusted_private_chat"] as const;

/** A /createRoom request (https://spec.matrix.org/v1.16/client-server-api/#post_matrixclientv3createroom), checked. */
export function parseCreateRoom(body: Record<string, unknown>, defaultVersion: string) {
  const version = body.room_version ?? defaultVersion;
  if (typeof version !== "string") throw errors.badJson("room_version must be a string");
  if (!SUPPORTED_ROOM_VERSIONS.includes(version)) throw errors.unsupportedRoomVersion();
  const visibility = body.visibility === "public" ? "public" : "private";
  const preset = body.preset ?? (visibility === "public" ? "public_chat" : "private_chat");
  if (!isPreset(preset)) throw errors.invalidParam("Unknown preset");
  const creationContent = body.creation_content ?? {};
  if (!isObject(creationContent)) throw errors.badJson("creation_content must be an object");
  const initialState = body.initial_state ?? [];
  if (!Array.isArray(initialState)) throw errors.badJson("initial_state must be an array");
  const invite = body.invite ?? [];
  if (!Array.isArray(invite) || !invite.every(isValidUserId)) throw errors.invalidParam("invite must be a list of user IDs");
  const { name, topic } = body;
  if (name !== undefined && typeof name !== "string") throw errors.badJson("name must be a string");
  if (topic !== undefined && typeof topic !== "string") throw errors.badJson("topic must be a string");
  if (Array.isArray(body.invite_3pid) && body.invite_3pid.length > 0) throw errors.threepidDenied();
  return {
    version,
    visibility,
    preset,
    creationContent,
    initialState: initialState.map(initialStateEvent),
    invite,
    name,
    topic,
    aliasName: aliasName(body.room_alias_name),
    override: powerLevelOverride(body.power_level_content_override),
    isDirect: !!body.is_direct,
  };
}

function isPreset(value: unknown): value is (typeof PRESETS)[number] {
  return PRESETS.some((p) => p === value);
}

function aliasName(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || /[:\s#]/.test(value) || value.length === 0) throw errors.invalidParam("Invalid room_alias_name");
  return value;
}

function powerLevelOverride(value: unknown) {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw errors.badJson("power_level_content_override must be an object");
  return value;
}

function initialStateEvent(ev: unknown) {
  // https://github.com/k18k/katrix/issues/128: state_key was read as any, so a non-string one was stored as is.
  if (
    !isObject(ev) ||
    typeof ev.type !== "string" ||
    !isObject(ev.content) ||
    (ev.state_key !== undefined && typeof ev.state_key !== "string")
  )
    throw errors.badJson("Invalid initial_state event");
  return { type: ev.type, state_key: ev.state_key ?? "", content: ev.content };
}

/** The initial state event that sets the power levels, if any. */
export function initialPowerLevels(initialState: ReturnType<typeof initialStateEvent>[]) {
  return initialState.find((e) => e.type === M.ROOM.POWER_LEVELS && e.state_key === "");
}
