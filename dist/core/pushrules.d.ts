import type { Homeserver } from "#homeserver.ts";
export type Rule = Record<string, any>;
export type Ruleset = Record<string, Rule[]>;
export declare const KINDS: string[];
export declare function defaultRules(userId: string): Ruleset;
/** Serialise read-modify-write cycles on a user's push rules (cluster-wide). */
export declare function withRulesLock<T>(hs: Homeserver, userId: string, fn: () => Promise<T>): Promise<T>;
/** A user's push rules, as a copy the caller may change. */
export declare function loadRules(hs: Homeserver, userId: string): Promise<Ruleset>;
/**
 * A user's push rules, shared and frozen: for callers that only read them.
 *
 * https://github.com/k18k/katrix/issues/41: push evaluation copied every
 * member's rules for every message, about 6% of the CPU under load, though it only reads them.
 * The cached rulesets are deep-frozen, so a caller that tries to change one fails loudly instead
 * of changing everyone's.
 */
export declare function readOnlyRules(hs: Homeserver, userId: string): Promise<Readonly<Ruleset>>;
export declare function saveRules(hs: Homeserver, userId: string, rules: Ruleset): Promise<void>;
/** Copy room-specific push rules from an upgraded room's predecessor to the new room. */
export declare function copyRoomPushRules(hs: Homeserver, userId: string, oldRoomId: string, newRoomId: string): Promise<void>;
