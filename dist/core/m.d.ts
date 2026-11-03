export declare const M: {
    readonly BEACON_INFO: "m.beacon_info";
    readonly CALL: {
        readonly INVITE: "m.call.invite";
    };
    readonly CHANGE_PASSWORD: "m.change_password";
    readonly DEVICE_LIST_UPDATE: "m.device_list_update";
    readonly DIRECT: "m.direct";
    readonly DIRECT_TO_DEVICE: "m.direct_to_device";
    readonly FEDERATE: "m.federate";
    readonly FULLY_READ: "m.fully_read";
    readonly GET_LOGIN_TOKEN: "m.get_login_token";
    readonly HEROES: "m.heroes";
    readonly HOMESERVER: "m.homeserver";
    readonly ID: {
        readonly PHONE: "m.id.phone";
        readonly THIRDPARTY: "m.id.thirdparty";
        readonly USER: "m.id.user";
    };
    readonly IGNORED_USER_LIST: "m.ignored_user_list";
    readonly IN_REPLY_TO: "m.in_reply_to";
    readonly INVITED_MEMBER_COUNT: "m.invited_member_count";
    readonly INVITE_PERMISSION_CONFIG: "m.invite_permission_config";
    readonly JOINED_MEMBER_COUNT: "m.joined_member_count";
    readonly LOGIN: {
        readonly APPLICATION_SERVICE: "m.login.application_service";
        readonly DUMMY: "m.login.dummy";
        readonly EMAIL: {
            readonly IDENTITY: "m.login.email.identity";
        };
        readonly MSISDN: "m.login.msisdn";
        readonly PASSWORD: "m.login.password";
        readonly REGISTRATION_TOKEN: "m.login.registration_token";
        readonly SSO: "m.login.sso";
        readonly TOKEN: "m.login.token";
    };
    readonly NOTICE: "m.notice";
    readonly OAUTH: "m.oauth";
    readonly POLL: {
        readonly START: "m.poll.start";
    };
    readonly PRESENCE: "m.presence";
    readonly PROFILE_FIELDS: "m.profile_fields";
    readonly PUSH_RULES: "m.push_rules";
    readonly REACTION: "m.reaction";
    readonly READ: {
        readonly _: "m.read";
        readonly PRIVATE: "m.read.private";
    };
    readonly RECEIPT: "m.receipt";
    readonly RELATES_TO: "m.relates_to";
    readonly RELATIONS: "m.relations";
    readonly RELATIONSHIP: "m.relationship";
    readonly REPLACE: "m.replace";
    readonly ROLE: {
        readonly ADMIN: "m.role.admin";
        readonly SECURITY: "m.role.security";
    };
    readonly ROOM: {
        readonly ALIASES: "m.room.aliases";
        readonly AVATAR: "m.room.avatar";
        readonly CANONICAL_ALIAS: "m.room.canonical_alias";
        readonly CREATE: "m.room.create";
        readonly ENCRYPTED: "m.room.encrypted";
        readonly ENCRYPTION: "m.room.encryption";
        readonly GUEST_ACCESS: "m.room.guest_access";
        readonly HISTORY_VISIBILITY: "m.room.history_visibility";
        readonly JOIN_RULES: "m.room.join_rules";
        readonly MEMBER: "m.room.member";
        readonly MESSAGE: "m.room.message";
        readonly NAME: "m.room.name";
        readonly POLICY: "m.room.policy";
        readonly POWER_LEVELS: "m.room.power_levels";
        readonly REDACTION: "m.room.redaction";
        readonly SERVER_ACL: "m.room.server_acl";
        readonly THIRD_PARTY_INVITE: "m.room.third_party_invite";
        readonly TOMBSTONE: "m.room.tombstone";
        readonly TOPIC: "m.room.topic";
    };
    readonly ROOM_MEMBERSHIP: "m.room_membership";
    readonly ROOM_VERSIONS: "m.room_versions";
    readonly RULE: {
        readonly CALL: ".m.rule.call";
        readonly CONTAINS_DISPLAY_NAME: ".m.rule.contains_display_name";
        readonly CONTAINS_USER_NAME: ".m.rule.contains_user_name";
        readonly ENCRYPTED: ".m.rule.encrypted";
        readonly ENCRYPTED_ROOM_ONE_TO_ONE: ".m.rule.encrypted_room_one_to_one";
        readonly INVITE_FOR_ME: ".m.rule.invite_for_me";
        readonly IS_ROOM_MENTION: ".m.rule.is_room_mention";
        readonly IS_USER_MENTION: ".m.rule.is_user_mention";
        readonly MASTER: ".m.rule.master";
        readonly MEMBER_EVENT: ".m.rule.member_event";
        readonly MESSAGE: ".m.rule.message";
        readonly REACTION: ".m.rule.reaction";
        readonly ROOM: {
            readonly SERVER_ACL: ".m.rule.room.server_acl";
        };
        readonly ROOM_ONE_TO_ONE: ".m.rule.room_one_to_one";
        readonly ROOMNOTIF: ".m.rule.roomnotif";
        readonly SUPPRESS_EDITS: ".m.rule.suppress_edits";
        readonly SUPPRESS_NOTICES: ".m.rule.suppress_notices";
        readonly TOMBSTONE: ".m.rule.tombstone";
    };
    readonly SERVER: "m.server";
    readonly SERVER_NOTICE: "m.server_notice";
    readonly SET_AVATAR_URL: "m.set_avatar_url";
    readonly SET_DISPLAYNAME: "m.set_displayname";
    readonly SIGNING_KEY_UPDATE: "m.signing_key_update";
    readonly SPACE: {
        readonly _: "m.space";
        readonly CHILD: "m.space.child";
    };
    readonly STICKER: "m.sticker";
    readonly TAG: "m.tag";
    readonly TEXT: "m.text";
    readonly THREAD: "m.thread";
    readonly THREEPID_CHANGES: "m.3pid_changes";
    readonly TOPIC: "m.topic";
    readonly TYPING: "m.typing";
    readonly UPLOAD: {
        readonly SIZE: "m.upload.size";
    };
};
export declare const UNSTABLE: {
    readonly DE: {
        readonly SORUNOME: {
            readonly MSC2409: {
                readonly EPHEMERAL: "de.sorunome.msc2409.ephemeral";
                readonly PUSH_EPHEMERAL: "de.sorunome.msc2409.push_ephemeral";
            };
        };
    };
    readonly IO: {
        readonly ELEMENT: {
            readonly MSC4306: {
                readonly RULE: {
                    readonly SUBSCRIBED_THREAD: ".io.element.msc4306.rule.subscribed_thread";
                    readonly UNSUBSCRIBED_THREAD: ".io.element.msc4306.rule.unsubscribed_thread";
                };
                readonly THREAD_SUBSCRIPTION: "io.element.msc4306.thread_subscription";
            };
            readonly MSC4308: {
                readonly THREAD_SUBSCRIPTIONS: "io.element.msc4308.thread_subscriptions";
            };
        };
    };
    readonly ORG: {
        readonly MATRIX: {
            readonly CROSS_SIGNING_RESET: "org.matrix.cross_signing_reset";
            readonly CUSTOM: {
                readonly HTML: "org.matrix.custom.html";
            };
            readonly MSC2732: {
                readonly FALLBACK_KEYS: "org.matrix.msc2732.fallback_keys";
            };
            readonly MSC3202: {
                readonly DEVICE_ID: "org.matrix.msc3202.device_id";
            };
            readonly MSC3381: {
                readonly POLL: {
                    readonly END: "org.matrix.msc3381.poll.end";
                    readonly RESPONSE: "org.matrix.msc3381.poll.response";
                    readonly START: "org.matrix.msc3381.poll.start";
                };
            };
            readonly MSC3874: {
                readonly NOT_REL_TYPES: "org.matrix.msc3874.not_rel_types";
                readonly REL_TYPES: "org.matrix.msc3874.rel_types";
            };
            readonly MSC3916: {
                readonly STABLE: "org.matrix.msc3916.stable";
            };
            readonly MSC3930: {
                readonly RULE: {
                    readonly POLL_END: ".org.matrix.msc3930.rule.poll_end";
                    readonly POLL_END_ONE_TO_ONE: ".org.matrix.msc3930.rule.poll_end_one_to_one";
                    readonly POLL_RESPONSE: ".org.matrix.msc3930.rule.poll_response";
                    readonly POLL_START: ".org.matrix.msc3930.rule.poll_start";
                    readonly POLL_START_ONE_TO_ONE: ".org.matrix.msc3930.rule.poll_start_one_to_one";
                };
            };
            readonly MSC4140: {
                readonly _: "org.matrix.msc4140";
                readonly DELAY: "org.matrix.msc4140.delay";
                readonly MAX_DELAY: "org.matrix.msc4140.max_delay";
            };
            readonly MSC4143: {
                readonly _: "org.matrix.msc4143";
                readonly RTC_FOCI: "org.matrix.msc4143.rtc_foci";
            };
            readonly MSC4155: {
                readonly ERRCODE: "org.matrix.msc4155.errcode";
                readonly INVITE_PERMISSION_CONFIG: "org.matrix.msc4155.invite_permission_config";
            };
            readonly MSC4222: {
                readonly _: "org.matrix.msc4222";
                readonly STATE_AFTER: "org.matrix.msc4222.state_after";
                readonly USE_STATE_AFTER: "org.matrix.msc4222.use_state_after";
            };
            readonly MSC4306: "org.matrix.msc4306";
            readonly MSC4429: {
                readonly PROFILE_FIELDS: "org.matrix.msc4429.profile_fields";
                readonly USERS: "org.matrix.msc4429.users";
            };
            readonly SIMPLIFIED_MSC3575: "org.matrix.simplified_msc3575";
        };
    };
};
