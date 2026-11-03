import type { Homeserver } from "#homeserver.ts";
import type { Router } from "#http/router.ts";
import { type SsoResult } from "#core/sso.ts";
export declare function validateNewUsername(hs: Homeserver, raw: unknown): Promise<string>;
export declare function createUser(hs: Homeserver, localpart: string, opts: {
    password?: string;
    guest?: boolean;
    admin?: boolean;
    displayname?: string;
}): Promise<string>;
/**
 * Check a password login, with the audit entries and automatic provisioning of `/login`; returns
 * the user ID. Shared with the OAuth server's login page.
 */
export declare function checkPasswordLogin(hs: Homeserver, userId: string, password: string, request: {
    ip: string | null;
    userAgent: string | null;
}): Promise<string>;
export declare const ssoConfirmPage: (serverName: string, result: SsoResult) => import("undici-types").Response;
export declare function registerAccountRoutes(r: Router): void;
export declare function registrationFlows(hs: Homeserver): Promise<string[][]>;
export declare function registrationTokenValid(hs: Homeserver, token: string): Promise<boolean>;
/**
 * Count one use of a registration token; throws when it has expired or has no uses left.
 *
 * https://github.com/k18k/katrix/issues/81 — race condition (CWE-362), limit bypass (CWE-841):
 * the use was checked at the UIA stage and counted later in a separate read and write, so concurrent registrations
 * all passed the check, and a use was not counted at all when the token stage was not the last one. The token now
 * comes from the UIA session, and the check and the count happen together under a lock per token.
 */
export declare function redeemRegistrationToken(hs: Homeserver, token: string): Promise<void>;
export declare function wellKnown(hs: Homeserver): Record<string, any> | null;
