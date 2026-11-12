import { PushAction, PushCondition, PushRule, PushRuleKind, PushRuleset, Pusher, SetPusherRequest } from "../shared/api/push.js";
import { NotificationsResponse } from "../shared/api/rooms.js";
import { LooseRule } from "../shared/push.js";
import { MatrixHttpApi } from "../http/api.js";
import { MatrixEvent } from "../models/event.js";
import { Room } from "../models/room.js";
/** What the push rules say about an event for this user. */
export interface PushOutcome {
  notify: boolean;
  /** `highlight`: a mention or keyword; `sound`: the sound to play ("default", "ring"). */
  highlight: boolean;
  sound?: string;
  actions: unknown[];
}
/**
 * Push notifications (https://spec.matrix.org/v1.19/client-server-api/#push-notifications):
 * pushers (where the server sends pushes), push rules (what notifies), the list of past
 * notifications, and evaluating the rules on the client.
 *
 * The server evaluates the rules for pushes and unread counts, but it cannot read encrypted
 * events: it can only apply the rules for "an encrypted event". The client, which decrypts them,
 * evaluates the rules again on the plaintext (MatrixClient's "notification" event).
 */
export declare class PushApi {
  private readonly api;
  private readonly userId;
  private readonly accountData;
  constructor(api: MatrixHttpApi, userId: string, accountData: (type: string) => Record<string, unknown> | undefined);
  pushers(): Promise<Pusher[]>;
  /**
   * Add or update a pusher: for an HTTP pusher, `data.url` is the push gateway's
   * /_matrix/push/v1/notify. `append: false` (the default) replaces pushers with the same
   * pushkey for other users.
   */
  setPusher(pusher: Omit<SetPusherRequest, "kind"> & {
    kind: string;
  }): Promise<void>;
  removePusher(appId: string, pushkey: string): Promise<void>;
  /** The user's push rules, from GET /pushrules/ (`scope: "global"` asks for /pushrules/global/ directly). */
  rules(opts?: {
    scope?: "all" | "global";
  }): Promise<PushRuleset>;
  getRule(kind: PushRuleKind, ruleId: string): Promise<PushRule>;
  /**
   * Add or replace a user-defined rule. `before`/`after` place it relative to another rule of
   * the same kind. Room rules take the room ID as `ruleId`, sender rules the user ID, content
   * rules a `pattern`, override and underride rules `conditions`.
   */
  setRule(kind: PushRuleKind, ruleId: string, rule: {
    actions: PushAction[];
    conditions?: PushCondition[];
    pattern?: string;
  }, opts?: {
    before?: string;
    after?: string;
  }): Promise<void>;
  deleteRule(kind: PushRuleKind, ruleId: string): Promise<void>;
  isRuleEnabled(kind: PushRuleKind, ruleId: string): Promise<boolean>;
  setRuleEnabled(kind: PushRuleKind, ruleId: string, enabled: boolean): Promise<void>;
  getRuleActions(kind: PushRuleKind, ruleId: string): Promise<PushAction[]>;
  setRuleActions(kind: PushRuleKind, ruleId: string, actions: PushAction[]): Promise<void>;
  /**
   * Mute a room. By default mentions and keywords still notify: that is a room rule, which the
   * spec evaluates after the override rules for mentions. `mentions: false` mutes everything,
   * with an override rule on the room ID that comes before them.
   */
  muteRoom(roomId: string, opts?: {
    mentions?: boolean;
  }): Promise<void>;
  /** Undo muteRoom, either kind. */
  unmuteRoom(roomId: string): Promise<void>;
  /** Mute everything: the master rule (.m.rule.master) on. */
  setMuteAll(muted: boolean): Promise<void>;
  /** The server's list of events that notified this user, newest first. `only: "highlight"` for mentions only. */
  notifications(opts?: {
    from?: string;
    limit?: number;
    only?: "highlight";
  }): Promise<NotificationsResponse>;
  /** The rules in effect: the synced m.push_rules account data, else the spec's defaults. */
  currentRules(): Readonly<Record<string, readonly LooseRule[] | undefined>>;
  /**
   * Evaluate the push rules on an event as the server would, with the room's current state: its
   * joined member count, this user's display name in it, and the sender's power level. Pass a
   * decrypted event to get what an encrypted one really should do.
   */
  evaluate(event: MatrixEvent, room: Room): PushOutcome;
}
//# sourceMappingURL=push.d.ts.map