import { errors } from "./errors.ts";
import { roomVersionFeatures, stateKey, versionNum, type PDU } from "./events.ts";
import { isObject } from "./json.ts";
import { publicKeyFromBase64, verifyJsonSignature } from "./crypto.ts";
import { isValidUserId } from "./ids.ts";
import { M } from "./m.ts";

export type StateMap = Map<string, PDU>;

/** MSC3757: the user owning a state key of the form "@user:server" or "@user:server_suffix". */
export function ownerOfStateKey(stateKeyValue: string): string | null {
  const key: string = stateKeyValue;
  if (!key.startsWith("@")) return null;
  if (isValidUserId(stateKeyValue)) return stateKeyValue;
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const underscore = key.indexOf("_", colon);
  if (underscore < 0) return null;
  const owner = key.slice(0, underscore);
  return isValidUserId(owner) ? owner : null;
}

export function getState(state: StateMap, type: string, key = ""): PDU | undefined {
  return state.get(stateKey(type, key));
}

export function membershipOf(state: StateMap, userId: string): string {
  return getState(state, M.ROOM.MEMBER, userId)?.content?.membership ?? "leave";
}

export function roomCreator(state: StateMap, roomVersion: string): string | undefined {
  const create = getState(state, M.ROOM.CREATE);
  if (!create) return undefined;
  return roomVersionFeatures(roomVersion).v11 ? create.sender : (create.content.creator ?? create.sender);
}

const toInt = (v: unknown, fallback: number): number => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10);
  return fallback;
};

/** v12+: the create event's sender plus `additional_creators`. Empty for older versions. */
export function roomCreators(state: StateMap, roomVersion: string): Set<string> {
  if (!roomVersionFeatures(roomVersion).v12) return new Set();
  const create = getState(state, M.ROOM.CREATE);
  if (!create) return new Set();
  const extra = Array.isArray(create.content?.additional_creators) ? create.content.additional_creators : [];
  return new Set([create.sender, ...extra.filter((u: unknown) => typeof u === "string")]);
}

export const MAX_POWER_LEVEL = Number.MAX_SAFE_INTEGER;

export interface PowerLevels {
  /** v12+: users with unlimited power. */
  creators: Set<string>;
  users: Record<string, number>;
  users_default: number;
  events: Record<string, number>;
  events_default: number;
  state_default: number;
  ban: number;
  kick: number;
  redact: number;
  invite: number;
  notifications: Record<string, number>;
}

export function powerLevels(state: StateMap, roomVersion: string): PowerLevels {
  const pl = getState(state, M.ROOM.POWER_LEVELS)?.content;
  const creators = roomCreators(state, roomVersion);
  if (!pl) {
    const creator = roomCreator(state, roomVersion);
    return {
      creators,
      users: creator ? { [creator]: 100 } : {},
      users_default: 0,
      events: {},
      events_default: 0,
      state_default: 0,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      notifications: { room: 50 },
    };
  }
  const users: Record<string, number> = {};
  if (isObject(pl.users)) for (const [u, v] of Object.entries(pl.users)) users[u] = toInt(v, 0);
  const events: Record<string, number> = {};
  if (isObject(pl.events)) for (const [e, v] of Object.entries(pl.events)) events[e] = toInt(v, 0);
  const notifications: Record<string, number> = { room: 50 };
  if (isObject(pl.notifications)) for (const [e, v] of Object.entries(pl.notifications)) notifications[e] = toInt(v, 50);
  return {
    creators,
    users,
    events,
    notifications,
    users_default: toInt(pl.users_default, 0),
    events_default: toInt(pl.events_default, 0),
    state_default: toInt(pl.state_default, 50),
    ban: toInt(pl.ban, 50),
    kick: toInt(pl.kick, 50),
    redact: toInt(pl.redact, 50),
    invite: toInt(pl.invite, 0),
  };
}

export function userLevel(pl: PowerLevels, userId: string): number {
  if (pl.creators.has(userId)) return Infinity;
  return pl.users[userId] ?? pl.users_default;
}

export function requiredLevel(pl: PowerLevels, type: string, isState: boolean): number {
  return pl.events[type] ?? (isState ? pl.state_default : pl.events_default);
}

export interface AuthCheckOptions {
  /** Whether a `join_authorised_via_users_server` join is signed by that user's server (checked by the caller). */
  joinAuthorisedSignatureValid?: boolean;
}

const sameDomain = (a: string, b: string) => a.slice(a.indexOf(":") + 1) === b.slice(b.indexOf(":") + 1);
const domainOf = (id: string) => id.slice(id.indexOf(":") + 1);

/** The (type, state_key) pairs an event's auth_events may reference (spec "auth events selection"). */
export function authEventKeys(
  event: { type: string; sender: string; state_key?: string; content: Record<string, any> },
  roomVersion: string,
): string[] {
  if (event.type === M.ROOM.CREATE) return [];
  const keys = [stateKey(M.ROOM.POWER_LEVELS, ""), stateKey(M.ROOM.MEMBER, event.sender)];
  if (!roomVersionFeatures(roomVersion).v12) keys.unshift(stateKey(M.ROOM.CREATE, ""));
  if (event.type === M.ROOM.MEMBER && typeof event.state_key === "string") {
    keys.push(stateKey(M.ROOM.MEMBER, event.state_key));
    const membership = event.content?.membership;
    if (["join", "invite", "knock"].includes(membership)) keys.push(stateKey(M.ROOM.JOIN_RULES, ""));
    const token = event.content?.third_party_invite?.signed?.token;
    if (membership === "invite" && typeof token === "string") keys.push(stateKey(M.ROOM.THIRD_PARTY_INVITE, token));
    const via = event.content?.join_authorised_via_users_server;
    if (membership === "join" && typeof via === "string" && roomVersionFeatures(roomVersion).restricted)
      keys.push(stateKey(M.ROOM.MEMBER, via));
  }
  return [...new Set(keys)];
}

/**
 * Build the auth state for an event from its auth_events, validating rule 2 of the
 * authorization rules (no duplicates, only expected types). For v12 the create event
 * (identified by the room ID) must be supplied separately.
 */
export function authStateFromAuthEvents(event: PDU, authEvents: PDU[], roomVersion: string, createEvent?: PDU): StateMap {
  const allowed = new Set(authEventKeys(event, roomVersion));
  const state: StateMap = new Map();
  for (const ev of authEvents) {
    if (ev.state_key === undefined) throw errors.forbidden("Auth event is not a state event");
    const key = stateKey(ev.type, ev.state_key);
    if (state.has(key)) throw errors.forbidden("Duplicate auth event");
    if (!allowed.has(key)) throw errors.forbidden(`Unexpected auth event ${ev.type}`);
    if (roomVersionFeatures(roomVersion).v12 && ev.type === M.ROOM.CREATE)
      throw errors.forbidden("Create event must not be in auth_events");
    state.set(key, ev);
  }
  if (createEvent) state.set(stateKey(M.ROOM.CREATE, ""), createEvent);
  return state;
}

/**
 * The Matrix authorization rules: throws M_FORBIDDEN if `event` is not allowed
 * given `state` (either its auth events or the state before it).
 */
export function checkAuth(event: PDU, state: StateMap, roomVersion: string, opts: AuthCheckOptions = {}): void {
  const features = roomVersionFeatures(roomVersion);
  const n = versionNum(roomVersion);
  const deny = (msg: string): never => {
    throw errors.forbidden(msg);
  };

  // 1. Create events.
  if (event.type === M.ROOM.CREATE) {
    if (state.size > 0 || (Array.isArray(event.prev_events) && event.prev_events.length > 0)) deny("Create event must be the first event");
    if (!features.v12 && event.room_id && !sameDomain(event.room_id, event.sender)) deny("Room ID domain must match the creator");
    const rv = event.content?.room_version;
    if (rv !== undefined && (typeof rv !== "string" || !Number.isFinite(versionNum(rv)))) deny("Unknown room version");
    if (!features.v11 && typeof event.content?.creator !== "string") deny("Create event lacks a creator");
    if (features.v12) {
      const extra = event.content?.additional_creators;
      if (extra !== undefined && (!Array.isArray(extra) || !extra.every(isValidUserId))) deny("Invalid additional_creators");
    }
    return;
  }

  // 3. A create event must be present.
  const create = getState(state, M.ROOM.CREATE);
  if (!create) deny("No create event in room");

  // 4. Non-federated rooms.
  if (create!.content?.[M.FEDERATE] === false && !sameDomain(event.sender, create!.sender)) deny("Room is not federated");

  // 5. Aliases events (v1-5).
  if (n <= 5 && event.type === M.ROOM.ALIASES) {
    if (event.state_key === undefined) deny("Aliases event lacks a state key");
    if (event.state_key !== domainOf(event.sender)) deny("Aliases state key must be the sender's domain");
    return;
  }

  const pl = powerLevels(state, roomVersion);
  const senderMembership = membershipOf(state, event.sender);
  const senderLevel = userLevel(pl, event.sender);

  // 6. Membership events.
  if (event.type === M.ROOM.MEMBER) {
    const target = event.state_key;
    const membership = event.content?.membership;
    if (typeof target !== "string" || typeof membership !== "string") deny("Member event lacks state_key or membership");
    const targetMembership = membershipOf(state, target!);
    const joinRule = getState(state, M.ROOM.JOIN_RULES)?.content?.join_rule ?? "invite";
    const via = event.content?.join_authorised_via_users_server;

    switch (membership) {
      case "join": {
        // The creator's own first join.
        const prev = Array.isArray(event.prev_events) ? event.prev_events.map((p: any) => (Array.isArray(p) ? p[0] : p)) : [];
        const creator = roomCreator(state, roomVersion);
        if (prev.length === 1 && prev[0] === create!.event_id && target === creator && event.sender === target) return;
        if (state.size === 1 && creator === target && event.sender === target) return;
        if (event.sender !== target) deny("Cannot force another user to join");
        if (targetMembership === "ban") deny("User is banned from the room");
        if (joinRule === "invite" || (features.knock && joinRule === "knock")) {
          if (targetMembership === "join" || targetMembership === "invite") return;
          deny("You are not invited to this room");
        }
        if ((features.restricted && joinRule === "restricted") || (features.knockRestricted && joinRule === "knock_restricted")) {
          if (targetMembership === "join" || targetMembership === "invite") return;
          // Only when the restricted rule is what admits the user must the authorising server have signed the join.
          if (typeof via === "string" && opts.joinAuthorisedSignatureValid === false)
            deny("join_authorised_via_users_server is not signed by that server");
          if (typeof via === "string" && membershipOf(state, via) === "join" && userLevel(pl, via) >= pl.invite) return;
          deny("Join not authorised by restricted join rules");
        }
        if (joinRule === "public") return;
        deny("You are not allowed to join this room");
        break;
      }
      case "invite": {
        const tpi = event.content?.third_party_invite;
        if (tpi !== undefined) {
          if (targetMembership === "ban") deny("User is banned");
          if (!checkThirdPartyInvite(event, state)) deny("Invalid third party invite");
          return;
        }
        if (senderMembership !== "join") deny("Sender not in room");
        if (targetMembership === "join" || targetMembership === "ban")
          deny(`User is already ${targetMembership === "join" ? "joined" : "banned"}`);
        if (senderLevel >= pl.invite) return;
        deny("Insufficient power level to invite");
        break;
      }
      case "leave": {
        if (event.sender === target) {
          if (targetMembership === "join" || targetMembership === "invite" || (features.knock && targetMembership === "knock")) return;
          deny("User is not in the room");
        }
        if (senderMembership !== "join") deny("Sender not in room");
        if (targetMembership === "ban" && senderLevel < pl.ban) deny("Insufficient power level to unban");
        if (senderLevel >= pl.kick && userLevel(pl, target!) < senderLevel) return;
        deny("Insufficient power level to kick");
        break;
      }
      case "ban": {
        if (senderMembership !== "join") deny("Sender not in room");
        if (senderLevel >= pl.ban && userLevel(pl, target!) < senderLevel) return;
        deny("Insufficient power level to ban");
        break;
      }
      case "knock": {
        if (!features.knock) deny("Knocking is not supported in this room version");
        if (joinRule !== "knock" && !(features.knockRestricted && joinRule === "knock_restricted")) deny("Room does not allow knocking");
        if (event.sender !== target) deny("Cannot knock on behalf of another user");
        if (targetMembership === "ban" || targetMembership === "join" || targetMembership === "invite")
          deny(`Cannot knock while ${targetMembership}`);
        return;
      }
      default:
        deny("Unknown membership");
    }
    return;
  }

  // 7. The sender must be joined.
  if (senderMembership !== "join") deny("You are not joined to this room");

  // 8. Third party invites.
  if (event.type === M.ROOM.THIRD_PARTY_INVITE) {
    if (senderLevel >= pl.invite) return;
    deny("Insufficient power level to invite");
  }

  // 9. Power level for the event type.
  const isState = event.state_key !== undefined;
  if (senderLevel < requiredLevel(pl, event.type, isState)) deny("Insufficient power level to send this event");

  // 10. User-owned state keys.
  if (isState && event.state_key!.startsWith("@") && event.state_key !== event.sender) {
    if (!features.ownedState) deny("State keys starting with @ are reserved for that user");
    const owner = ownerOfStateKey(event.state_key!);
    if (!owner) deny("Malformed user-owned state key");
    // MSC3757: the owner, or anyone with more power than the owner, may set it.
    if (owner !== event.sender && senderLevel <= userLevel(pl, owner!)) deny("This state key belongs to another user");
  }

  // 11. Power level changes.
  if (event.type === M.ROOM.POWER_LEVELS && isState) {
    if (isObject(event.content?.users)) {
      for (const u of Object.keys(event.content.users)) {
        if (!isValidUserId(u)) deny("Power level users must be valid user IDs");
        if (pl.creators.has(u)) deny("Room creators cannot be given a power level");
      }
    }
    if (getState(state, M.ROOM.POWER_LEVELS)) checkPowerLevelChange(event, pl, senderLevel, features.integerPowerLevels, n >= 6, deny);
    else checkPowerLevelShape(event, features.integerPowerLevels, deny);
    return;
  }

  // 12. Redactions (v1-2 only).
  if (n <= 2 && event.type === M.ROOM.REDACTION) {
    if (senderLevel >= pl.redact) return;
    const redacts = event.redacts;
    if (typeof redacts === "string" && redacts.includes(":") && domainOf(redacts) === domainOf(event.sender)) return;
    deny("Insufficient power level to redact");
  }
}

function checkThirdPartyInvite(event: PDU, state: StateMap): boolean {
  const signed = event.content?.third_party_invite?.signed;
  if (!isObject(signed) || typeof signed.mxid !== "string" || typeof signed.token !== "string") return false;
  if (signed.mxid !== event.state_key) return false;
  const invite = getState(state, M.ROOM.THIRD_PARTY_INVITE, signed.token);
  if (!invite || invite.sender !== event.sender) return false;
  const keys: string[] = [];
  if (typeof invite.content?.public_key === "string") keys.push(invite.content.public_key);
  for (const k of Array.isArray(invite.content?.public_keys) ? invite.content.public_keys : [])
    if (typeof k?.public_key === "string") keys.push(k.public_key);
  for (const key of keys) {
    let pub;
    try {
      pub = publicKeyFromBase64(key);
    } catch {
      continue;
    }
    for (const [server, sigs] of Object.entries(isObject(signed.signatures) ? signed.signatures : {})) {
      for (const keyId of Object.keys(isObject(sigs) ? sigs : {})) {
        if (verifyJsonSignature(signed, server, keyId, pub)) return true;
      }
    }
  }
  return false;
}

function checkPowerLevelShape(event: PDU, integerOnly: boolean, deny: (m: string) => never): void {
  if (!integerOnly) return;
  const c = event.content ?? {};
  const isInt = (v: unknown) => typeof v === "number" && Number.isInteger(v);
  for (const key of ["users_default", "events_default", "state_default", "ban", "redact", "kick", "invite"]) {
    if (key in c && !isInt(c[key])) deny(`${key} must be an integer`);
  }
  for (const map of ["users", "events", "notifications"]) {
    if (map in c && !isObject(c[map])) deny(`${map} must be an object`);
    if (isObject(c[map])) for (const v of Object.values(c[map])) if (!isInt(v)) deny(`${map} values must be integers`);
  }
}

function checkPowerLevelChange(
  event: PDU,
  current: PowerLevels,
  senderLevel: number,
  integerOnly: boolean,
  checkNotifications: boolean,
  deny: (m: string) => never,
): void {
  const c = event.content ?? {};
  checkPowerLevelShape(event, integerOnly, deny);
  if (!integerOnly) {
    for (const map of ["users", "events", "notifications"]) if (map in c && !isObject(c[map])) deny(`${map} must be an object`);
  }
  const next = {
    users_default: toInt(c.users_default, 0),
    events_default: toInt(c.events_default, 0),
    state_default: toInt(c.state_default, 50),
    ban: toInt(c.ban, 50),
    redact: toInt(c.redact, 50),
    kick: toInt(c.kick, 50),
    invite: toInt(c.invite, 0),
  } as Record<string, number>;
  for (const key of Object.keys(next)) {
    const old = (current as any)[key] as number;
    if (old !== next[key] && (old > senderLevel || next[key] > senderLevel)) deny(`Cannot change ${key} beyond your own level`);
  }
  const compareMap = (oldMap: Record<string, number>, newMap: Record<string, any>, isUsers: boolean) => {
    const keys = new Set([...Object.keys(oldMap), ...Object.keys(newMap ?? {})]);
    for (const k of keys) {
      const o = oldMap[k];
      const nv = newMap?.[k] === undefined ? undefined : toInt(newMap[k], 0);
      if (o === nv) continue;
      if (isUsers) {
        if (k !== event.sender && o !== undefined && o >= senderLevel) deny("Cannot change the level of a user with equal or higher power");
        if (nv !== undefined && nv > senderLevel) deny("Cannot set a level above your own");
      } else {
        if (o !== undefined && o > senderLevel) deny("Cannot change a level above your own");
        if (nv !== undefined && nv > senderLevel) deny("Cannot set a level above your own");
      }
    }
  };
  compareMap(current.users, c.users ?? {}, true);
  compareMap(current.events, c.events ?? {}, false);
  if (checkNotifications) {
    const oldNotif = { ...current.notifications };
    // `room` defaults to 50 when unset; only compare explicitly set values.
    compareMap(oldNotif, { room: 50, ...c.notifications }, false);
  }
}
