import type { Homeserver } from "../homeserver.ts";

/** Security-relevant actions recorded in the audit log. */
export type AuditAction =
  | "login" | "login_failed" | "logout" | "register" | "password_change" | "deactivate"
  | "device_create" | "device_delete" | "token_refresh"
  | "room_create" | "room_delete" | "member_kick" | "member_ban" | "member_unban"
  | "admin_action" | "admin_command" | "registration_token_create" | "registration_token_delete"
  | "registration_setting" | "event_report" | "user_report" | "sso_login" | "oauth_login"
  | "user_lock" | "user_unlock" | "user_suspend" | "user_unsuspend";

export interface AuditEntry {
  action: AuditAction;
  /** User (or "server") performing the action. */
  actor: string | null;
  /** Subject of the action (user, room, token…). */
  target?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  outcome?: "success" | "failure";
  details?: Record<string, unknown>;
}

export interface AuditOptions {
  /** Enable the audit log. Default: false. */
  enabled?: boolean;
  /** Store entries in the database (queryable via the admin API). Default: true. */
  database?: boolean;
  /** Additional sink, e.g. to forward to a SIEM. Errors are logged, never thrown. */
  sink?: (entry: AuditEntry & { ts: number; id: number }) => void | Promise<void>;
  /** Only record these actions. Default: all. */
  actions?: AuditAction[];
  /** Delete database entries older than this many days. Default: 365. `0` keeps them forever. */
  retentionDays?: number;
}

/** Audit log of security-relevant actions (logins, account changes, admin actions…). */
export class AuditService {
  private hs: Homeserver;
  readonly options: AuditOptions;

  constructor(hs: Homeserver, options: AuditOptions = {}) {
    this.hs = hs;
    this.options = options;
  }

  get enabled(): boolean {
    return !!this.options.enabled;
  }

  /** Record an entry. Never throws: auditing must not break the action being audited. */
  async record(entry: AuditEntry): Promise<void> {
    if (!this.options.enabled) return;
    if (this.options.actions && !this.options.actions.includes(entry.action)) return;
    try {
      const id = await this.hs.cluster.nextId("audit_log");
      const ts = Date.now();
      const row = {
        id, ts, action: entry.action, actor: entry.actor ?? null, target: entry.target ?? null, ip: entry.ip ?? null,
        user_agent: entry.userAgent ?? null, outcome: entry.outcome ?? "success", details: entry.details ?? {},
      };
      if (this.options.database !== false) await this.hs.db.create("audit_log", row);
      await this.options.sink?.({ ...entry, outcome: row.outcome, id, ts });
    } catch (err) {
      this.hs.logger.error("Failed to write audit log entry", err);
    }
  }

  async query(opts: { actor?: string; target?: string; action?: string; since?: number; before?: number; limit?: number } = {}) {
    const where: any[] = [];
    if (opts.actor) where.push({ field: "actor", value: opts.actor });
    if (opts.target) where.push({ field: "target", value: opts.target });
    if (opts.action) where.push({ field: "action", value: opts.action });
    if (opts.since) where.push({ field: "ts", operator: "gte", value: opts.since });
    if (opts.before) where.push({ field: "id", operator: "lt", value: opts.before });
    return this.hs.db.findMany("audit_log", { where, sortBy: { field: "id", direction: "desc" }, limit: Math.min(opts.limit ?? 100, 1000) });
  }

  async prune(): Promise<void> {
    const days = this.options.retentionDays ?? 365;
    if (!this.options.enabled || days <= 0) return;
    await this.hs.db.delete("audit_log", [{ field: "ts", operator: "lt", value: Date.now() - days * 86_400_000 }]);
  }
}
