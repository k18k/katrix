import type { MatrixHttpApi } from "../http/api.ts";
import { MatrixError } from "../http/errors.ts";
import type { MatrixEvent } from "../models/event.ts";
import type { Room } from "../models/room.ts";
import {
  defaultPushRules,
  evaluatePushRules,
  isObject,
  type LooseRule,
  pushTweaks,
  type NotificationsResponse,
  type PushAction,
  type PushCondition,
  type PushRule,
  type PushRuleKind,
  type PushRuleset,
  type Pusher,
  type SetPusherRequest,
} from "@katrix/shared";

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
export class PushApi {
  private readonly api: MatrixHttpApi;
  private readonly userId: string;
  private readonly accountData: (type: string) => Record<string, unknown> | undefined;

  constructor(api: MatrixHttpApi, userId: string, accountData: (type: string) => Record<string, unknown> | undefined) {
    this.api = api;
    this.userId = userId;
    this.accountData = accountData;
  }

  // ─── Pushers ──────────────────────────────────────────────────────────────

  async pushers(): Promise<Pusher[]> {
    return (await this.api.endpoint("GET /v3/pushers", {}, {})).pushers ?? [];
  }

  /**
   * Add or update a pusher: for an HTTP pusher, `data.url` is the push gateway's
   * /_matrix/push/v1/notify. `append: false` (the default) replaces pushers with the same
   * pushkey for other users.
   */
  async setPusher(pusher: Omit<SetPusherRequest, "kind"> & { kind: string }): Promise<void> {
    await this.api.endpoint("POST /v3/pushers/set", {}, { body: pusher });
  }

  async removePusher(appId: string, pushkey: string): Promise<void> {
    await this.api.endpoint("POST /v3/pushers/set", {}, { body: { app_id: appId, pushkey, kind: null } });
  }

  // ─── Push rules ───────────────────────────────────────────────────────────

  /** The user's push rules, from GET /pushrules/ (`scope: "global"` asks for /pushrules/global/ directly). */
  async rules(opts: { scope?: "all" | "global" } = {}): Promise<PushRuleset> {
    if (opts.scope === "global") return this.api.endpoint("GET /v3/pushrules/global/", {}, {});
    return (await this.api.endpoint("GET /v3/pushrules/", {}, {})).global ?? {};
  }

  getRule(kind: PushRuleKind, ruleId: string): Promise<PushRule> {
    return this.api.endpoint("GET /v3/pushrules/global/:kind/:ruleId", { kind, ruleId }, {});
  }

  /**
   * Add or replace a user-defined rule. `before`/`after` place it relative to another rule of
   * the same kind. Room rules take the room ID as `ruleId`, sender rules the user ID, content
   * rules a `pattern`, override and underride rules `conditions`.
   */
  async setRule(
    kind: PushRuleKind,
    ruleId: string,
    rule: { actions: PushAction[]; conditions?: PushCondition[]; pattern?: string },
    opts: { before?: string; after?: string } = {},
  ): Promise<void> {
    await this.api.endpoint(
      "PUT /v3/pushrules/global/:kind/:ruleId",
      { kind, ruleId },
      { query: { before: opts.before, after: opts.after }, body: rule },
    );
  }

  async deleteRule(kind: PushRuleKind, ruleId: string): Promise<void> {
    await this.api.endpoint("DELETE /v3/pushrules/global/:kind/:ruleId", { kind, ruleId }, {});
  }

  async isRuleEnabled(kind: PushRuleKind, ruleId: string): Promise<boolean> {
    return (await this.api.endpoint("GET /v3/pushrules/global/:kind/:ruleId/enabled", { kind, ruleId }, {})).enabled;
  }

  async setRuleEnabled(kind: PushRuleKind, ruleId: string, enabled: boolean): Promise<void> {
    await this.api.endpoint("PUT /v3/pushrules/global/:kind/:ruleId/enabled", { kind, ruleId }, { body: { enabled } });
  }

  async getRuleActions(kind: PushRuleKind, ruleId: string): Promise<PushAction[]> {
    return (await this.api.endpoint("GET /v3/pushrules/global/:kind/:ruleId/actions", { kind, ruleId }, {})).actions;
  }

  async setRuleActions(kind: PushRuleKind, ruleId: string, actions: PushAction[]): Promise<void> {
    await this.api.endpoint("PUT /v3/pushrules/global/:kind/:ruleId/actions", { kind, ruleId }, { body: { actions } });
  }

  /**
   * Mute a room. By default mentions and keywords still notify: that is a room rule, which the
   * spec evaluates after the override rules for mentions. `mentions: false` mutes everything,
   * with an override rule on the room ID that comes before them.
   */
  async muteRoom(roomId: string, opts: { mentions?: boolean } = {}): Promise<void> {
    if (opts.mentions === false) {
      const before = (await this.rules()).override?.find((r) => !r.default)?.rule_id;
      await this.setRule(
        "override",
        roomId,
        { actions: [], conditions: [{ kind: "event_match", key: "room_id", pattern: roomId }] },
        // Ahead of the default overrides: a user rule is placed before them anyway, this keeps
        // it ahead of the user's other overrides too.
        before ? { before } : {},
      );
    } else await this.setRule("room", roomId, { actions: [] });
  }

  /** Undo muteRoom, either kind. */
  async unmuteRoom(roomId: string): Promise<void> {
    for (const kind of ["room", "override"] as const) {
      await this.deleteRule(kind, roomId).catch((e) => {
        if (!(e instanceof MatrixError && e.errcode === "M_NOT_FOUND")) throw e;
      });
    }
  }

  /** Mute everything: the master rule (.m.rule.master) on. */
  setMuteAll(muted: boolean): Promise<void> {
    return this.setRuleEnabled("override", ".m.rule.master", muted);
  }

  // ─── Notifications ────────────────────────────────────────────────────────

  /** The server's list of events that notified this user, newest first. `only: "highlight"` for mentions only. */
  notifications(opts: { from?: string; limit?: number; only?: "highlight" } = {}): Promise<NotificationsResponse> {
    return this.api.endpoint("GET /v3/notifications", {}, { query: { from: opts.from, limit: opts.limit, only: opts.only } });
  }

  // ─── Evaluation ───────────────────────────────────────────────────────────

  /** The rules in effect: the synced m.push_rules account data, else the spec's defaults. */
  currentRules(): Readonly<Record<string, readonly LooseRule[] | undefined>> {
    const global = this.accountData("m.push_rules")?.global;
    return isObject(global) ? (global as Record<string, LooseRule[]>) : defaultPushRules(this.userId);
  }

  /**
   * Evaluate the push rules on an event as the server would, with the room's current state: its
   * joined member count, this user's display name in it, and the sender's power level. Pass a
   * decrypted event to get what an encrypted one really should do.
   */
  evaluate(event: MatrixEvent, room: Room): PushOutcome {
    const pl = room.state.powerLevels();
    const senderLevel = event.sender ? room.state.powerLevel(event.sender) : 0;
    const actions =
      evaluatePushRules(this.currentRules(), {
        event: { ...event.wire, type: event.type, content: event.content, room_id: room.roomId },
        userId: this.userId,
        displayName: room.state.member(this.userId)?.rawDisplayName ?? null,
        memberCount: room.summary.joinedMemberCount ?? room.state.members().filter((m) => m.membership === "join").length,
        senderLevel: Number.isFinite(senderLevel) ? senderLevel : Number.MAX_SAFE_INTEGER,
        notificationLevels: { room: 50, ...(isObject(pl.notifications) ? pl.notifications : {}) },
      }) ?? [];
    const tweaks = pushTweaks(actions);
    return {
      notify: actions.includes("notify"),
      highlight: tweaks.highlight === true,
      sound: typeof tweaks.sound === "string" ? tweaks.sound : undefined,
      actions,
    };
  }
}
