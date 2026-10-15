import { isObject } from "./json.ts";
import type { Homeserver } from "../homeserver.ts";

export const INVITE_CONFIG_TYPE = "org.matrix.msc4155.invite_permission_config";

const globMatch = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value);

/**
 * MSC4155 invite filtering: "allow", "ignore" (accept but hide) or "block" (refuse).
 * User rules take precedence over server rules; within each, allow > ignore > block.
 */
export async function inviteDecision(hs: Homeserver, target: string, inviter: string): Promise<"allow" | "ignore" | "block"> {
  const row = await hs.db.findOne("account_data", [{ field: "user_id", value: target }, { field: "room_id", value: "" }, { field: "type", value: INVITE_CONFIG_TYPE }]);
  const config = row?.content;
  if (!isObject(config)) return "allow";
  const list = (k: string): string[] => (Array.isArray(config[k]) ? config[k].filter((x: unknown) => typeof x === "string") : []);
  const server = inviter.slice(inviter.indexOf(":") + 1);
  for (const [level, value] of [["users", inviter], ["servers", server]] as const) {
    if (list(`allowed_${level}`).some((p) => globMatch(p, value))) return "allow";
    if (list(`ignored_${level}`).some((p) => globMatch(p, value))) return "ignore";
    if (list(`blocked_${level}`).some((p) => globMatch(p, value))) return "block";
  }
  return "allow";
}
