/** Audit log of security-relevant actions (logins, account changes, admin actions…). */
export class AuditService {
    hs;
    options;
    constructor(hs, options = {}) {
        this.hs = hs;
        this.options = options;
    }
    get enabled() {
        return !!this.options.enabled;
    }
    /** Record an entry. Never throws: auditing must not break the action being audited. */
    async record(entry) {
        if (!this.options.enabled)
            return;
        if (this.options.actions && !this.options.actions.includes(entry.action))
            return;
        try {
            const id = await this.hs.cluster.nextId("audit_log");
            const ts = Date.now();
            const row = {
                id,
                ts,
                action: entry.action,
                actor: entry.actor ?? null,
                target: entry.target ?? null,
                ip: entry.ip ?? null,
                user_agent: entry.userAgent ?? null,
                outcome: entry.outcome ?? "success",
                details: entry.details ?? {},
            };
            if (this.options.database !== false)
                await this.hs.db.create("audit_log", row);
            await this.options.sink?.({ ...entry, outcome: row.outcome, id, ts });
        }
        catch (err) {
            this.hs.logger.error("Failed to write audit log entry", err);
        }
    }
    async query(opts = {}) {
        const where = [];
        if (opts.actor)
            where.push({ field: "actor", value: opts.actor });
        if (opts.target)
            where.push({ field: "target", value: opts.target });
        if (opts.action)
            where.push({ field: "action", value: opts.action });
        if (opts.since)
            where.push({ field: "ts", operator: "gte", value: opts.since });
        if (opts.before)
            where.push({ field: "id", operator: "lt", value: opts.before });
        return this.hs.db.findMany("audit_log", {
            where,
            sortBy: { field: "id", direction: "desc" },
            limit: Math.min(opts.limit ?? 100, 1000),
        });
    }
    async prune() {
        const days = this.options.retentionDays ?? 365;
        if (!this.options.enabled || days <= 0)
            return;
        await this.hs.db.delete("audit_log", [{ field: "ts", operator: "lt", value: Date.now() - days * 86_400_000 }]);
    }
}
