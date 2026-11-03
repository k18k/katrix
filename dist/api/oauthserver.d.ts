import type { Homeserver } from "#homeserver.ts";
import type { RequestContext, Router } from "#http/router.ts";
/** A browser's session on the pages. */
export interface WebSession {
    sid: string;
    csrf: string;
    userId?: string;
    authTime?: number;
}
/** The browser's session, if it has one. */
export declare function readWebSession(ctx: RequestContext): Promise<WebSession | null>;
/** Log the browser session in (password, registration or an upstream provider). */
export declare function setWebUser(hs: Homeserver, web: WebSession, userId: string | undefined): Promise<void>;
export declare function registerOAuthServerRoutes(r: Router): void;
