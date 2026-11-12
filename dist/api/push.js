import { M } from "../shared/m.js";
import { errors } from "../core/errors.js";
import { KINDS, loadRules, saveRules, withRulesLock } from "../core/pushrules.js";
import { v } from "../core/vpm.js";
import { body, fail, lenient } from "../http/input.js";
import { procedure } from "../http/procedure.js";
// src/api/push.ts
const pusherKey = v.string(fail("M_MISSING_PARAM", "Missing app_id or pushkey"));
const pusherBody = body({
	app_id: pusherKey,
	pushkey: pusherKey,
	kind: lenient(v.string().nullable()),
	app_display_name: lenient(v.string()),
	device_display_name: lenient(v.string()),
	lang: lenient(v.string()),
	data: lenient(v.looseObject({ url: lenient(v.string()) })),
	append: v.unknown().optional()
});
function findRule(rules, kind, ruleId) {
	if (!KINDS.includes(kind)) throw errors.invalidParam("Unknown rule kind");
	const rule = rules[kind]?.find((r) => r.rule_id === ruleId);
	if (!rule) throw errors.notFound("Unknown push rule");
	return rule;
}
async function ruleCtx(ctx) {
	const s = await ctx.auth();
	if (ctx.params.scope !== "global") throw errors.invalidParam("Unknown scope");
	return {
		s,
		rules: await loadRules(ctx.hs, s.userId)
	};
}
function registerPushRoutes(r) {
	r.client("GET", "/pushrules", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			return { global: await loadRules(ctx.hs, s.userId) };
		}
	}));
	r.client("GET", "/pushrules/:scope", procedure({ handler: async (ctx) => {
		const { rules } = await ruleCtx(ctx);
		return rules;
	} }));
	r.client("GET", "/pushrules/:scope/:kind/:ruleId", procedure({ handler: async (ctx) => {
		const { rules } = await ruleCtx(ctx);
		return findRule(rules, ctx.params.kind, ctx.params.ruleId);
	} }));
	r.client("DELETE", "/pushrules/:scope/:kind/:ruleId", procedure({ handler: async (ctx) => withRulesLock(ctx.hs, (await ctx.auth()).userId, async () => {
		const { s, rules } = await ruleCtx(ctx);
		const rule = findRule(rules, ctx.params.kind, ctx.params.ruleId);
		if (rule.default) throw errors.forbidden("Cannot delete a default rule");
		rules[ctx.params.kind] = rules[ctx.params.kind].filter((x) => x !== rule);
		await saveRules(ctx.hs, s.userId, rules);
		return {};
	}) }));
	r.client("PUT", "/pushrules/:scope/:kind/:ruleId", procedure({ handler: async (ctx) => withRulesLock(ctx.hs, (await ctx.auth()).userId, async () => {
		const { s, rules } = await ruleCtx(ctx);
		const { kind, ruleId } = ctx.params;
		if (!KINDS.includes(kind)) throw errors.invalidParam("Unknown rule kind");
		if (ruleId.startsWith(".")) throw errors.invalidParam("Rule IDs starting with '.' are reserved");
		const body = await ctx.json();
		if (!Array.isArray(body.actions)) throw errors.badJson("actions must be a list");
		const rule = {
			rule_id: ruleId,
			default: false,
			enabled: true,
			actions: body.actions
		};
		if (kind === "content") {
			if (typeof body.pattern !== "string") throw errors.missingParam("Missing pattern");
			rule.pattern = body.pattern;
		}
		if (kind === "override" || kind === "underride") rule.conditions = Array.isArray(body.conditions) ? body.conditions : [];
		const list = (rules[kind] ??= []).filter((x) => x.rule_id !== ruleId);
		const before = ctx.query.get("before");
		const after = ctx.query.get("after");
		let index = list.findIndex((x) => x.default && x.rule_id !== M.RULE.MASTER);
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
	}) }));
	for (const attr of ["enabled", "actions"]) {
		r.client("GET", `/pushrules/:scope/:kind/:ruleId/${attr}`, procedure({ handler: async (ctx) => {
			const { rules } = await ruleCtx(ctx);
			return { [attr]: findRule(rules, ctx.params.kind, ctx.params.ruleId)[attr] };
		} }));
		r.client("PUT", `/pushrules/:scope/:kind/:ruleId/${attr}`, procedure({ handler: async (ctx) => withRulesLock(ctx.hs, (await ctx.auth()).userId, async () => {
			const { s, rules } = await ruleCtx(ctx);
			const rule = findRule(rules, ctx.params.kind, ctx.params.ruleId);
			const body = await ctx.json();
			if (attr === "enabled" && typeof body.enabled !== "boolean") throw errors.badJson("enabled must be a boolean");
			if (attr === "actions" && !Array.isArray(body.actions)) throw errors.badJson("actions must be a list");
			rule[attr] = body[attr];
			await saveRules(ctx.hs, s.userId, rules);
			return {};
		}) }));
	}
	r.client("GET", "/pushers", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			return { pushers: (await ctx.hs.db.findMany("pushers", { where: [{
				field: "user_id",
				value: s.userId
			}] })).map((r) => r.pusher) };
		}
	}));
	r.client("POST", "/pushers/set", procedure({
		auth: "user",
		input: pusherBody,
		handler: async (ctx) => {
			const s = ctx.session;
			const body = ctx.input;
			if (body.kind === null) {
				await ctx.hs.db.delete("pushers", [
					{
						field: "user_id",
						value: s.userId
					},
					{
						field: "app_id",
						value: body.app_id
					},
					{
						field: "pushkey",
						value: body.pushkey
					}
				]);
				return {};
			}
			for (const k of [
				"kind",
				"app_display_name",
				"device_display_name",
				"lang"
			]) if (body[k] === void 0) throw errors.missingParam(`Missing ${k}`);
			if (!body.data) throw errors.missingParam("Missing data");
			if (body.kind === "http" && body.data.url === void 0) throw errors.invalidParam("data.url is required for http pushers");
			if (!body.append) {
				const others = await ctx.hs.db.findMany("pushers", { where: [{
					field: "app_id",
					value: body.app_id
				}, {
					field: "pushkey",
					value: body.pushkey
				}] });
				for (const o of others) await ctx.hs.db.delete("pushers", [
					{
						field: "user_id",
						value: o.user_id
					},
					{
						field: "app_id",
						value: o.app_id
					},
					{
						field: "pushkey",
						value: o.pushkey
					}
				]);
			}
			const { append, ...pusher } = body;
			await ctx.hs.db.upsert("pushers", {
				user_id: s.userId,
				app_id: body.app_id,
				pushkey: body.pushkey,
				device_id: s.deviceId,
				pusher
			});
			return {};
		}
	}));
	r.client("GET", "/notifications", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const from = ctx.query.get("from");
			const limit = Math.min(Math.max(Number.parseInt(ctx.query.get("limit") ?? "20", 10) || 20, 1), 100);
			const rows = await ctx.hs.push.list(s.userId, {
				from: from ? Number.parseInt(from, 10) : null,
				limit,
				onlyHighlight: ctx.query.get("only") === "highlight"
			});
			const out = { notifications: rows.map(({ stream, ...n }) => n) };
			if (rows.length === limit) out.next_token = String(rows[rows.length - 1].stream);
			return out;
		}
	}));
}
export { registerPushRoutes };

//# sourceMappingURL=push.js.map