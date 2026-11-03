import type { Homeserver } from "#homeserver.ts";
export declare const BUILTIN_FIELDS: Set<string>;
export declare const MAX_PROFILE_BYTES = 65536;
export declare const MAX_KEY_BYTES = 255;
export declare function fullProfile(hs: Homeserver, userId: string): Promise<Record<string, unknown> | null>;
export declare function profileSize(profile: Record<string, unknown>): number;
/** Set (or with `null`, clear) one profile field and notify users sharing a room. */
export declare function setProfileField(hs: Homeserver, userId: string, field: string, value: unknown): Promise<void>;
