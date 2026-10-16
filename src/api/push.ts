import { errors } from "../core/errors.ts";
import { isObject } from "../core/json.ts";
import { KINDS, loadRules, saveRules, withRulesLock, type Rule, type Ruleset } from "../core/pushrules.ts";
import type { RequestContext, Router } from "../http/router.ts";

function findRule(rules: Ruleset, kind: string, ruleId: string): Rule {
  if (!KINDS.includes(kind)) throw errors.invalidParam("Unknown rule kind");
  const rule = rules[kind]?.find((r) => r.rule_id === ruleId);
  if (!rule) throw errors.notFound("Unknown push rule");
  return rule;
}

async function ruleCtx(ctx: RequestContext) {
  const s = await ctx.auth();
  if (ctx.params.scope !== "global") throw errors.invalidParam("Unknown scope");
  return { s, rules: await loadRules(ctx.hs, s.userId) };
}

export function registerPushRoutes(r: Router): void {
  r.client("GET", "/pushrules", async (ctx) => {
    const s = await ctx.auth();
    return { global: await loadRules(ctx.hs, s.userId) };
  });
  r.client("GET", "/pushrules/:scope", async (ctx) => {
    const { rules } = await ruleCtx(ctx);
    return rules;
  });
  r.client("GET", "/pushrules/:scope/:kind/:ruleId", async (ctx) => {
    const { rules } = await ruleCtx(ctx);
    return findRule(rules, ctx.params.kind, ctx.params.ruleId);
  });
  r.client("DELETE", "/pushrules/:scope/:kind/:ruleId", async (ctx) =>
    withRulesLock(ctx.hs, (await ctx.auth()).userId, async () => {
      const { s, rules } = await ruleCtx(ctx);
      const rule = findRule(rules, ctx.params.kind, ctx.params.ruleId);
      if (rule.default) throw errors.forbidden("Cannot delete a default rule");
      rules[ctx.params.kind] = rules[ctx.params.kind].filter((x) => x !== rule);
      await saveRules(ctx.hs, s.userId, rules);
      return {};
    }),
  );
  r.client("PUT", "/pushrules/:scope/:kind/:ruleId", async (ctx) =>
    withRulesLock(ctx.hs, (await ctx.auth()).userId, async () => {
      const { s, rules } = await ruleCtx(ctx);
      const { kind, ruleId } = ctx.params;
      if (!KINDS.includes(kind)) throw errors.invalidParam("Unknown rule kind");
      if (ruleId.startsWith(".")) throw errors.invalidParam("Rule IDs starting with '.' are reserved");
      const body = await ctx.json();
      if (!Array.isArray(body.actions)) throw errors.badJson("actions must be a list");
      const rule: Rule = { rule_id: ruleId, default: false, enabled: true, actions: body.actions };
      if (kind === "content") {
        if (typeof body.pattern !== "string") throw errors.missingParam("Missing pattern");
        rule.pattern = body.pattern;
      }
      if (kind === "override" || kind === "underride") rule.conditions = Array.isArray(body.conditions) ? body.conditions : [];
      const list = (rules[kind] ??= []).filter((x) => x.rule_id !== ruleId);
      const before = ctx.query.get("before");
      const after = ctx.query.get("after");
      // User rules take priority over server defaults (except the master rule).
      let index = list.findIndex((x) => x.default && x.rule_id !== ".m.rule.master");
      if (index === -1) index = list.length;
      if (before) {
        index = list.findIndex((x) => x.rule_id === before);
        if (index === -1) throw errors.notFound("Unknown 'before' rule");
      } else if (after) {
        index = list.findIndex((x) => x.rule_id === after);
        if (index === -1) throw errors.notFound("Unknown 'after' rule");
        index++;
      }
      list.splice(index, 0, rule);
      rules[kind] = list;
      await saveRules(ctx.hs, s.userId, rules);
      return {};
    }),
  );
  for (const attr of ["enabled", "actions"] as const) {
    r.client("GET", `/pushrules/:scope/:kind/:ruleId/${attr}`, async (ctx) => {
      const { rules } = await ruleCtx(ctx);
      return { [attr]: findRule(rules, ctx.params.kind, ctx.params.ruleId)[attr] };
    });
    r.client("PUT", `/pushrules/:scope/:kind/:ruleId/${attr}`, async (ctx) =>
      withRulesLock(ctx.hs, (await ctx.auth()).userId, async () => {
        const { s, rules } = await ruleCtx(ctx);
        const rule = findRule(rules, ctx.params.kind, ctx.params.ruleId);
        const body = await ctx.json();
        if (attr === "enabled" && typeof body.enabled !== "boolean") throw errors.badJson("enabled must be a boolean");
        if (attr === "actions" && !Array.isArray(body.actions)) throw errors.badJson("actions must be a list");
        rule[attr] = body[attr];
        await saveRules(ctx.hs, s.userId, rules);
        return {};
      }),
    );
  }

  r.client("GET", "/pushers", async (ctx) => {
    const s = await ctx.auth();
    const rows = await ctx.hs.db.findMany("pushers", { where: [{ field: "user_id", value: s.userId }] });
    return { pushers: rows.map((r) => r.pusher) };
  });
  r.client("POST", "/pushers/set", async (ctx) => {
    const s = await ctx.auth();
    const body = await ctx.json();
    if (typeof body.app_id !== "string" || typeof body.pushkey !== "string") throw errors.missingParam("Missing app_id or pushkey");
    if (body.kind === null) {
      await ctx.hs.db.delete("pushers", [
        { field: "user_id", value: s.userId },
        { field: "app_id", value: body.app_id },
        { field: "pushkey", value: body.pushkey },
      ]);
      return {};
    }
    for (const k of ["kind", "app_display_name", "device_display_name", "lang"]) {
      if (typeof body[k] !== "string") throw errors.missingParam(`Missing ${k}`);
    }
    if (!isObject(body.data)) throw errors.missingParam("Missing data");
    if (body.kind === "http" && typeof body.data.url !== "string") throw errors.invalidParam("data.url is required for http pushers");
    if (!body.append) {
      const others = await ctx.hs.db.findMany("pushers", {
        where: [
          { field: "app_id", value: body.app_id },
          { field: "pushkey", value: body.pushkey },
        ],
      });
      for (const o of others)
        await ctx.hs.db.delete("pushers", [
          { field: "user_id", value: o.user_id },
          { field: "app_id", value: o.app_id },
          { field: "pushkey", value: o.pushkey },
        ]);
    }
    const { append, ...pusher } = body;
    await ctx.hs.db.upsert("pushers", { user_id: s.userId, app_id: body.app_id, pushkey: body.pushkey, device_id: s.deviceId, pusher });
    return {};
  });

  r.client("GET", "/notifications", async (ctx) => {
    const s = await ctx.auth();
    const from = ctx.query.get("from");
    const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "20", 10) || 20, 1), 100);
    const rows = await ctx.hs.push.list(s.userId, {
      from: from ? Number.parseInt(from, 10) : null,
      limit,
      onlyHighlight: ctx.query.get("only") === "highlight",
    });
    const out: Record<string, unknown> = { notifications: rows.map(({ stream, ...n }) => n) };
    if (rows.length === limit) out.next_token = String(rows[rows.length - 1].stream);
    return out;
  });
}
