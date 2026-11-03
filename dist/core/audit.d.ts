import type { Homeserver } from "#homeserver.ts";
/** Security-relevant actions recorded in the audit log. */
export type AuditAction = "login" | "login_failed" | "logout" | "register" | "password_change" | "deactivate" | "device_create" | "device_delete" | "token_refresh" | "room_create" | "room_delete" | "member_kick" | "member_ban" | "member_unban" | "admin_action" | "admin_command" | "registration_token_create" | "registration_token_delete" | "registration_setting" | "event_report" | "user_report" | "sso_login" | "oauth_login" | "user_lock" | "user_unlock" | "user_suspend" | "user_unsuspend";
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
    sink?: (entry: AuditEntry & {
        ts: number;
        id: number;
    }) => void | Promise<void>;
    /** Only record these actions. Default: all. */
    actions?: AuditAction[];
    /** Delete database entries older than this many days. Default: 365. `0` keeps them forever. */
    retentionDays?: number;
}
/** Audit log of security-relevant actions (logins, account changes, admin actions…). */
export declare class AuditService {
    private hs;
    readonly options: AuditOptions;
    constructor(hs: Homeserver, options?: AuditOptions);
    get enabled(): boolean;
    /** Record an entry. Never throws: auditing must not break the action being audited. */
    record(entry: AuditEntry): Promise<void>;
    query(opts?: {
        actor?: string;
        target?: string;
        action?: string;
        since?: number;
        before?: number;
        limit?: number;
    }): Promise<import("../index.ts").Row[]>;
    prune(): Promise<void>;
}
