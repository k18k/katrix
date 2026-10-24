import { isObject } from "#core/json.ts";
import { globMatch } from "#core/glob.ts";
import type { Homeserver } from "#homeserver.ts";
import { M, UNSTABLE } from "#core/m.ts";

export const INVITE_CONFIG_TYPE = UNSTABLE.ORG.MATRIX.MSC4155.INVITE_PERMISSION_CONFIG;

// Security (https://github.com/k18k/katrix/issues/2): rules come from users' account data. Compiled to regexes they allowed
// catastrophic backtracking that hung the server (ReDoS); matched in linear time (core/glob.ts).

/**
 * MSC4155 invite filtering: "allow", "ignore" (accept but hide) or "block" (refuse).
 * User rules take precedence over server rules; within each, allow > ignore > block.
 */
export async function inviteDecision(hs: Homeserver, target: string, inviter: string): Promise<"allow" | "ignore" | "block"> {
  // https://github.com/k18k/katrix/issues/88: the stable invite blocking of spec v1.18 (MSC4380)
  // was ignored. `default_action: "block"` in m.invite_permission_config refuses every invite.
  const stable = await hs.db.findOne("account_data", [
    { field: "user_id", value: target },
    { field: "room_id", value: "" },
    { field: "type", value: M.INVITE_PERMISSION_CONFIG },
  ]);
  if (stable?.content?.default_action === "block") return "block";
  const row = await hs.db.findOne("account_data", [
    { field: "user_id", value: target },
    { field: "room_id", value: "" },
    { field: "type", value: INVITE_CONFIG_TYPE },
  ]);
  const config = row?.content;
  if (!isObject(config)) return "allow";
  const list = (k: string): string[] => (Array.isArray(config[k]) ? config[k].filter((x: unknown) => typeof x === "string") : []);
  const server = inviter.slice(inviter.indexOf(":") + 1);
  for (const [level, value] of [
    ["users", inviter],
    ["servers", server],
  ] as const) {
    if (list(`allowed_${level}`).some((p) => globMatch(p, value))) return "allow";
    if (list(`ignored_${level}`).some((p) => globMatch(p, value))) return "ignore";
    if (list(`blocked_${level}`).some((p) => globMatch(p, value))) return "block";
  }
  return "allow";
}
