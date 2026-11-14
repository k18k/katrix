import { isObject } from "../packages/shared/src/json.js";
import { M, UNSTABLE } from "../packages/shared/src/m.js";
import { globMatch } from "../packages/shared/src/glob.js";
// src/core/invitefilter.ts
const INVITE_CONFIG_TYPE = UNSTABLE.ORG.MATRIX.MSC4155.INVITE_PERMISSION_CONFIG;
/**
* MSC4155 invite filtering: "allow", "ignore" (accept but hide) or "block" (refuse).
* User rules take precedence over server rules; within each, allow > ignore > block.
*/
async function inviteDecision(hs, target, inviter) {
	if ((await hs.db.findOne("account_data", [
		{
			field: "user_id",
			value: target
		},
		{
			field: "room_id",
			value: ""
		},
		{
			field: "type",
			value: M.INVITE_PERMISSION_CONFIG
		}
	]))?.content?.default_action === "block") return "block";
	const config = (await hs.db.findOne("account_data", [
		{
			field: "user_id",
			value: target
		},
		{
			field: "room_id",
			value: ""
		},
		{
			field: "type",
			value: INVITE_CONFIG_TYPE
		}
	]))?.content;
	if (!isObject(config)) return "allow";
	const list = (k) => Array.isArray(config[k]) ? config[k].filter((x) => typeof x === "string") : [];
	const server = inviter.slice(inviter.indexOf(":") + 1);
	for (const [level, value] of [["users", inviter], ["servers", server]]) {
		if (list(`allowed_${level}`).some((p) => globMatch(p, value))) return "allow";
		if (list(`ignored_${level}`).some((p) => globMatch(p, value))) return "ignore";
		if (list(`blocked_${level}`).some((p) => globMatch(p, value))) return "block";
	}
	return "allow";
}
export { INVITE_CONFIG_TYPE, inviteDecision };

//# sourceMappingURL=invitefilter.js.map