import type { Homeserver } from "#homeserver.ts";
export declare const INVITE_CONFIG_TYPE: "org.matrix.msc4155.invite_permission_config";
/**
 * MSC4155 invite filtering: "allow", "ignore" (accept but hide) or "block" (refuse).
 * User rules take precedence over server rules; within each, allow > ignore > block.
 */
export declare function inviteDecision(hs: Homeserver, target: string, inviter: string): Promise<"allow" | "ignore" | "block">;
