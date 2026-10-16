// The Matrix namespaced identifiers the server uses (event types, login and identifier types,
// capabilities, account data, relation types, push rule IDs, ...), as one readonly object, so code
// refers to `M.ROOM.MEMBER` instead of repeating the string "m.room.member".
//
// The keys follow the identifier: `m.login.msisdn` is `M.LOGIN.MSISDN`. Where an identifier is
// also the prefix of others, the identifier itself is `_`: `M.SPACE._` is "m.space", and
// `M.SPACE.CHILD` is "m.space.child". Push rule IDs keep their leading dot (`M.RULE.MASTER` is
// ".m.rule.master").

function deepFreeze<T extends object>(o: T): T {
  for (const v of Object.values(o)) if (typeof v === "object" && v !== null) deepFreeze(v);
  return Object.freeze(o);
}

export const M = deepFreeze({
  BEACON_INFO: "m.beacon_info",
  CALL: {
    INVITE: "m.call.invite",
  },
  CHANGE_PASSWORD: "m.change_password",
  DEVICE_LIST_UPDATE: "m.device_list_update",
  DIRECT: "m.direct",
  DIRECT_TO_DEVICE: "m.direct_to_device",
  FEDERATE: "m.federate",
  FULLY_READ: "m.fully_read",
  GET_LOGIN_TOKEN: "m.get_login_token",
  HEROES: "m.heroes",
  HOMESERVER: "m.homeserver",
  ID: {
    PHONE: "m.id.phone",
    THIRDPARTY: "m.id.thirdparty",
    USER: "m.id.user",
  },
  IGNORED_USER_LIST: "m.ignored_user_list",
  IN_REPLY_TO: "m.in_reply_to",
  INVITED_MEMBER_COUNT: "m.invited_member_count",
  JOINED_MEMBER_COUNT: "m.joined_member_count",
  LOGIN: {
    APPLICATION_SERVICE: "m.login.application_service",
    DUMMY: "m.login.dummy",
    EMAIL: {
      IDENTITY: "m.login.email.identity",
    },
    MSISDN: "m.login.msisdn",
    PASSWORD: "m.login.password",
    REGISTRATION_TOKEN: "m.login.registration_token",
    SSO: "m.login.sso",
    TOKEN: "m.login.token",
  },
  NOTICE: "m.notice",
  OAUTH: "m.oauth",
  POLL: {
    START: "m.poll.start",
  },
  PRESENCE: "m.presence",
  PROFILE_FIELDS: "m.profile_fields",
  PUSH_RULES: "m.push_rules",
  REACTION: "m.reaction",
  READ: {
    _: "m.read",
    PRIVATE: "m.read.private",
  },
  RECEIPT: "m.receipt",
  RELATES_TO: "m.relates_to",
  RELATIONS: "m.relations",
  RELATIONSHIP: "m.relationship",
  REPLACE: "m.replace",
  ROLE: {
    ADMIN: "m.role.admin",
    SECURITY: "m.role.security",
  },
  ROOM: {
    ALIASES: "m.room.aliases",
    AVATAR: "m.room.avatar",
    CANONICAL_ALIAS: "m.room.canonical_alias",
    CREATE: "m.room.create",
    ENCRYPTED: "m.room.encrypted",
    ENCRYPTION: "m.room.encryption",
    GUEST_ACCESS: "m.room.guest_access",
    HISTORY_VISIBILITY: "m.room.history_visibility",
    JOIN_RULES: "m.room.join_rules",
    MEMBER: "m.room.member",
    MESSAGE: "m.room.message",
    NAME: "m.room.name",
    POLICY: "m.room.policy",
    POWER_LEVELS: "m.room.power_levels",
    REDACTION: "m.room.redaction",
    SERVER_ACL: "m.room.server_acl",
    THIRD_PARTY_INVITE: "m.room.third_party_invite",
    TOMBSTONE: "m.room.tombstone",
    TOPIC: "m.room.topic",
  },
  ROOM_MEMBERSHIP: "m.room_membership",
  ROOM_VERSIONS: "m.room_versions",
  RULE: {
    CALL: ".m.rule.call",
    CONTAINS_DISPLAY_NAME: ".m.rule.contains_display_name",
    CONTAINS_USER_NAME: ".m.rule.contains_user_name",
    ENCRYPTED: ".m.rule.encrypted",
    ENCRYPTED_ROOM_ONE_TO_ONE: ".m.rule.encrypted_room_one_to_one",
    INVITE_FOR_ME: ".m.rule.invite_for_me",
    IS_ROOM_MENTION: ".m.rule.is_room_mention",
    IS_USER_MENTION: ".m.rule.is_user_mention",
    MASTER: ".m.rule.master",
    MEMBER_EVENT: ".m.rule.member_event",
    MESSAGE: ".m.rule.message",
    REACTION: ".m.rule.reaction",
    ROOM: {
      SERVER_ACL: ".m.rule.room.server_acl",
    },
    ROOM_ONE_TO_ONE: ".m.rule.room_one_to_one",
    ROOMNOTIF: ".m.rule.roomnotif",
    SUPPRESS_EDITS: ".m.rule.suppress_edits",
    SUPPRESS_NOTICES: ".m.rule.suppress_notices",
    TOMBSTONE: ".m.rule.tombstone",
  },
  SERVER: "m.server",
  SERVER_NOTICE: "m.server_notice",
  SET_AVATAR_URL: "m.set_avatar_url",
  SET_DISPLAYNAME: "m.set_displayname",
  SIGNING_KEY_UPDATE: "m.signing_key_update",
  SPACE: {
    _: "m.space",
    CHILD: "m.space.child",
  },
  STICKER: "m.sticker",
  TAG: "m.tag",
  TEXT: "m.text",
  THREAD: "m.thread",
  THREEPID_CHANGES: "m.3pid_changes",
  TOPIC: "m.topic",
  TYPING: "m.typing",
  UPLOAD: {
    SIZE: "m.upload.size",
  },
} as const);
