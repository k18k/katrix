import type { Homeserver } from "#homeserver.ts";
/** JSON response with a canonical (sorted, compact) body, needed where clients verify signatures over the raw bytes. */
export declare function canonicalJsonResponse(body: unknown): Response;
export declare function jsonResponse(body: unknown, status?: number, headers?: Record<string, string>): Response;
/** The largest request body the server accepts. Uploads are the largest bodies, so it follows the media upload limit, like Synapse's. */
export declare const maxRequestBody: (hs: Homeserver) => number;
export interface HandleOptions {
    ip?: string | null;
}
/** Turn a web-standard Request into a Response. */
export declare function handleRequest(hs: Homeserver, request: Request, options?: HandleOptions): Promise<Response>;
