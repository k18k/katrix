/** Push notifications (https://spec.matrix.org/v1.19/client-server-api/#push-notifications). */

export interface Pusher {
  pushkey: string;
  kind: string;
  app_id: string;
  app_display_name: string;
  device_display_name: string;
  profile_tag?: string;
  lang: string;
  data: { url?: string; format?: string; [key: string]: unknown };
}

export interface PushersResponse {
  pushers?: Pusher[];
}

/** POST /pushers/set: `kind: null` deletes the pusher. */
export interface SetPusherRequest {
  pushkey: string;
  kind: string | null;
  app_id: string;
  app_display_name?: string;
  device_display_name?: string;
  profile_tag?: string;
  lang?: string;
  data?: { url?: string; format?: "event_id_only"; [key: string]: unknown };
  append?: boolean;
}

export type PushRuleKind = "override" | "content" | "room" | "sender" | "underride";

export type PushAction = "notify" | "dont_notify" | "coalesce" | { set_tweak: string; value?: unknown } | Record<string, unknown> | string;

export type PushCondition =
  | { kind: "event_match"; key: string; pattern: string }
  | { kind: "event_property_is"; key: string; value: string | number | boolean | null }
  | { kind: "event_property_contains"; key: string; value: string | number | boolean | null }
  | { kind: "contains_display_name" }
  | { kind: "room_member_count"; is: string }
  | { kind: "sender_notification_permission"; key: string }
  | { kind: string; key?: string; pattern?: string; is?: string; value?: string | number | boolean | null };

export interface PushRule {
  actions: PushAction[];
  default: boolean;
  enabled: boolean;
  rule_id: string;
  conditions?: PushCondition[];
  pattern?: string;
}

export interface PushRuleset {
  override?: PushRule[];
  content?: PushRule[];
  room?: PushRule[];
  sender?: PushRule[];
  underride?: PushRule[];
}

export interface PushRulesResponse {
  global: PushRuleset;
}

export interface SetPushRuleRequest {
  actions: PushAction[];
  conditions?: PushCondition[];
  pattern?: string;
}

export interface PushRuleEnabledBody {
  enabled: boolean;
}

export interface PushRuleActionsBody {
  actions: PushAction[];
}
