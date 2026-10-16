import { getState, powerLevels, userLevel, type StateMap } from "#core/authrules.ts";
import { splitStateKey, toClientEvent, type PDU } from "#core/events.ts";
import { isObject } from "#core/json.ts";
import { globMatch, globSearchWords } from "#core/glob.ts";
import { KINDS, loadRules, type Rule } from "#core/pushrules.ts";
import { isSubscribed } from "#api/threadsubs.ts";
import type { StoredEvent } from "#core/rooms.ts";
import type { Homeserver } from "#homeserver.ts";

/** Look up a dotted path; `\.` escapes a literal dot in a key (e.g. `content.m\.relates_to`). */
export function valueAtPath(obj: unknown, path: string): unknown {
  const parts = path.split(/(?<!\\)\./).map((p) => p.replace(/\\\./g, ".").replace(/\\\\/g, "\\"));
  let cur: any = obj;
  for (const p of parts) {
    if (!isObject(cur) || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

interface EvalContext {
  event: PDU;
  userId: string;
  displayName: string | null;
  memberCount: number;
  senderLevel: number;
  notificationLevels: Record<string, number>;
  /** MSC4306: whether the user subscribes to the event's thread; undefined outside threads. */
  threadSubscribed?: boolean;
}

function conditionMatches(cond: Record<string, any>, ctx: EvalContext): boolean {
  switch (cond.kind) {
    case "event_match": {
      if (typeof cond.key !== "string" || typeof cond.pattern !== "string") return false;
      const value = valueAtPath(ctx.event, cond.key);
      if (typeof value !== "string") return false;
      // content.body is matched on word boundaries; other keys must match entirely.
      // Security (https://github.com/k18k/matrix-nodejs-homeserver/issues/2): patterns come from users' push rules and run against every event in
      // their rooms; as regexes they allowed catastrophic backtracking (ReDoS), so they are
      // matched in linear time (core/glob.ts).
      return cond.key === "content.body" ? globSearchWords(cond.pattern, value) : globMatch(cond.pattern, value, { caseInsensitive: true });
    }
    case "event_property_is":
      return typeof cond.key === "string" && valueAtPath(ctx.event, cond.key) === cond.value;
    case "event_property_contains": {
      const value = typeof cond.key === "string" ? valueAtPath(ctx.event, cond.key) : undefined;
      return Array.isArray(value) && value.includes(cond.value);
    }
    case "contains_display_name": {
      const body = ctx.event.content?.body;
      if (!ctx.displayName || typeof body !== "string") return false;
      const escaped = ctx.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|\\W)${escaped}(\\W|$)`, "i").test(body);
    }
    case "room_member_count": {
      const m = /^(==|<=|>=|<|>)?(\d+)$/.exec(String(cond.is ?? ""));
      if (!m) return false;
      const n = Number(m[2]);
      switch (m[1] ?? "==") {
        case "==":
          return ctx.memberCount === n;
        case "<":
          return ctx.memberCount < n;
        case ">":
          return ctx.memberCount > n;
        case "<=":
          return ctx.memberCount <= n;
        case ">=":
          return ctx.memberCount >= n;
      }
      return false;
    }
    case "io.element.msc4306.thread_subscription":
      return ctx.threadSubscribed !== undefined && ctx.threadSubscribed !== null && ctx.threadSubscribed === cond.subscribed;
    case "sender_notification_permission":
      return typeof cond.key === "string" && ctx.senderLevel >= (ctx.notificationLevels[cond.key] ?? 50);
    default:
      // Unknown condition kinds never match.
      return false;
  }
}

function ruleMatches(kind: string, rule: Rule, ctx: EvalContext): boolean {
  if (!rule.enabled) return false;
  switch (kind) {
    case "override":
    case "postcontent":
    case "underride":
      return (rule.conditions ?? []).every((c: Record<string, any>) => conditionMatches(c, ctx));
    case "content":
      return typeof rule.pattern === "string" && conditionMatches({ kind: "event_match", key: "content.body", pattern: rule.pattern }, ctx);
    case "room":
      return ctx.event.room_id === rule.rule_id;
    case "sender":
      return ctx.event.sender === rule.rule_id;
  }
  return false;
}

/** Evaluate a user's push rules against an event; returns the actions of the first matching rule. */
export function evaluateRules(rules: Record<string, Rule[]>, ctx: EvalContext): unknown[] | null {
  for (const kind of KINDS) {
    for (const rule of rules[kind] ?? []) if (ruleMatches(kind, rule, ctx)) return rule.actions ?? [];
  }
  return null;
}

export function tweaksOf(actions: unknown[]): Record<string, unknown> {
  const tweaks: Record<string, unknown> = {};
  for (const a of actions) {
    if (isObject(a) && typeof a.set_tweak === "string") tweaks[a.set_tweak] = "value" in a ? a.value : true;
  }
  return tweaks;
}

/** Thread an event belongs to for notification purposes ("main" for the main timeline). */
export function threadIdOf(event: PDU): string {
  const rel = event.content?.["m.relates_to"];
  return isObject(rel) && rel.rel_type === "m.thread" && typeof rel.event_id === "string" ? rel.event_id : "main";
}

/**
 * Push rule evaluation and push gateway delivery. Every new event is evaluated for
 * every local member; matches are stored for unread counts and `/notifications`.
 */
export class PushService {
  private hs: Homeserver;

  constructor(hs: Homeserver) {
    this.hs = hs;
  }

  async onEvent(ev: StoredEvent, state: StateMap, version: string): Promise<void> {
    const event = ev.pdu;
    const members: string[] = [];
    for (const [key, member] of state) {
      const [type, userId] = splitStateKey(key);
      if (type !== "m.room.member") continue;
      const m = member.content?.membership;
      // Invitees are evaluated for their own invite event.
      if (m === "join" || (m === "invite" && event.type === "m.room.member" && event.state_key === userId)) members.push(userId);
    }
    const joined = members.filter((u) => getState(state, "m.room.member", u)?.content?.membership === "join");
    const pl = powerLevels(state, version);
    const senderLevel = userLevel(pl, event.sender);
    const thread = threadIdOf(event);
    for (const userId of members) {
      if (userId === event.sender || !this.hs.isLocalUser(userId)) continue;
      const rules = await loadRules(this.hs, userId);
      const actions = evaluateRules(rules, {
        event,
        userId,
        displayName: getState(state, "m.room.member", userId)?.content?.displayname ?? null,
        memberCount: joined.length,
        senderLevel: Number.isFinite(senderLevel) ? senderLevel : Number.MAX_SAFE_INTEGER,
        notificationLevels: pl.notifications,
        threadSubscribed: thread === "main" ? undefined : await isSubscribed(this.hs, userId, event.room_id, thread),
      });
      if (!actions || !actions.includes("notify")) continue;
      const tweaks = tweaksOf(actions);
      await this.hs.db.upsert("notifications", {
        user_id: userId,
        room_id: event.room_id,
        event_id: event.event_id,
        stream: ev.stream,
        highlight: tweaks.highlight === true,
        thread_id: threadIdOf(event),
        actions,
        ts: Date.now(),
      });
      void this.deliver(userId, ev, state, tweaks).catch((err) => this.hs.logger.warn("Push delivery failed", err));
    }
  }

  /** Unread notification counts since the user's read receipts. */
  /** Stream positions up to which the user has read the room (unthreaded) and each thread. */
  private async readPositions(userId: string, roomId: string): Promise<{ unthreaded: number; threads: Map<string, number> }> {
    const receipts = await this.hs.db.findMany("receipts", {
      where: [
        { field: "room_id", value: roomId },
        { field: "user_id", value: userId },
      ],
    });
    let unthreaded = 0;
    const threadRead = new Map<string, number>();
    for (const r of receipts) {
      if (r.receipt_type !== "m.read" && r.receipt_type !== "m.read.private") continue;
      const target = await this.hs.rooms.getEvent(r.event_id);
      if (!target) continue;
      if (r.thread_id === "") unthreaded = Math.max(unthreaded, target.stream);
      else threadRead.set(r.thread_id, Math.max(threadRead.get(r.thread_id) ?? 0, target.stream));
    }
    return { unthreaded, threads: threadRead };
  }

  isRead(row: Record<string, any>, read: { unthreaded: number; threads: Map<string, number> }): boolean {
    return row.stream <= read.unthreaded || row.stream <= (read.threads.get(row.thread_id) ?? 0);
  }

  async unreadCounts(
    userId: string,
    roomId: string,
  ): Promise<{
    room: { notification_count: number; highlight_count: number };
    threads: Record<string, { notification_count: number; highlight_count: number }>;
  }> {
    const read = await this.readPositions(userId, roomId);
    const unthreaded = read.unthreaded;
    const rows = await this.hs.db.findMany("notifications", {
      where: [
        { field: "user_id", value: userId },
        { field: "room_id", value: roomId },
        { field: "stream", operator: "gt", value: unthreaded },
      ],
    });
    const room = { notification_count: 0, highlight_count: 0 };
    const threads: Record<string, { notification_count: number; highlight_count: number }> = {};
    for (const n of rows) {
      if (this.isRead(n, read)) continue;
      const bucket = n.thread_id === "main" ? room : (threads[n.thread_id] ??= { notification_count: 0, highlight_count: 0 });
      bucket.notification_count++;
      if (n.highlight) bucket.highlight_count++;
    }
    return { room, threads };
  }

  private async deliver(userId: string, ev: StoredEvent, state: StateMap, tweaks: Record<string, unknown>): Promise<void> {
    const pushers = await this.hs.db.findMany("pushers", { where: [{ field: "user_id", value: userId }] });
    if (pushers.length === 0) return;
    const event = ev.pdu;
    const unread = (await this.unreadCounts(userId, event.room_id)).room.notification_count;
    for (const row of pushers) {
      const pusher = row.pusher;
      if (pusher.kind !== "http" || typeof pusher.data?.url !== "string") continue;
      const { url, format, ...data } = pusher.data;
      const notification: Record<string, any> = {
        event_id: event.event_id,
        room_id: event.room_id,
        counts: { unread },
        devices: [{ app_id: pusher.app_id, pushkey: pusher.pushkey, pushkey_ts: Math.floor(Date.now() / 1000), data, tweaks }],
        prio: tweaks.highlight || tweaks.sound ? "high" : "low",
      };
      if (format !== "event_id_only") {
        notification.type = event.type;
        notification.sender = event.sender;
        notification.content = event.content;
        const name = getState(state, "m.room.name")?.content?.name;
        if (typeof name === "string") notification.room_name = name;
        const senderName = getState(state, "m.room.member", event.sender)?.content?.displayname;
        if (typeof senderName === "string") notification.sender_display_name = senderName;
        if (event.type === "m.room.member") {
          notification.membership = event.content?.membership;
          notification.user_is_target = event.state_key === userId;
        }
      }
      const res = await this.hs.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notification }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.hs.logger.warn("Push gateway returned", res.status, "for", url);
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as { rejected?: string[] };
      if (Array.isArray(body.rejected) && body.rejected.includes(pusher.pushkey)) {
        await this.hs.db.delete("pushers", [
          { field: "user_id", value: userId },
          { field: "app_id", value: pusher.app_id },
          { field: "pushkey", value: pusher.pushkey },
        ]);
      }
    }
  }

  /** Rows for `GET /notifications`. */
  async list(userId: string, opts: { from: number | null; limit: number; onlyHighlight: boolean }) {
    const where: any[] = [{ field: "user_id", value: userId }];
    if (opts.from !== null) where.push({ field: "stream", operator: "lt", value: opts.from });
    if (opts.onlyHighlight) where.push({ field: "highlight", value: true });
    const rows = await this.hs.db.findMany("notifications", { where, sortBy: { field: "stream", direction: "desc" }, limit: opts.limit });
    const out = [];
    const readByRoom = new Map<string, { unthreaded: number; threads: Map<string, number> }>();
    for (const row of rows) {
      const ev = await this.hs.rooms.getEvent(row.event_id);
      if (!ev) continue;
      let read = readByRoom.get(row.room_id);
      if (!read) readByRoom.set(row.room_id, (read = await this.readPositions(userId, row.room_id)));
      out.push({
        actions: row.actions,
        event: toClientEvent(ev.pdu),
        room_id: row.room_id,
        ts: row.ts,
        read: this.isRead(row, read),
        stream: row.stream,
      });
    }
    return out;
  }
}
