import type { Homeserver } from "#homeserver.ts";
import type { Session } from "#core/auth.ts";
export interface ValidatedThreepid {
    medium: "email" | "msisdn";
    address: string;
    validatedTs: number;
}
/**
 * User-interactive authentication. Resolves when one of `flows` has been
 * completed; otherwise throws the 401 response describing what is required.
 * `userId` binds password stages to an already-authenticated user. `session` is the caller's,
 * and `crossSigningReset` marks `/keys/device_signing/upload`, the one endpoint where tokens of
 * the OAuth 2.0 API may use UIA (the `m.oauth` stage).
 */
export declare function requireUia(hs: Homeserver, body: Record<string, any>, flows: string[][], userId: string | null, opts?: {
    session?: Session;
    crossSigningReset?: boolean;
}): Promise<{
    threepids: ValidatedThreepid[];
    registrationToken?: string;
}>;
