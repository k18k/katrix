import { Session } from "../core/auth.js";
import { RateLimitAction } from "../core/ratelimit.js";
import { Homeserver } from "../homeserver.js";
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export interface RequestContext {
  hs: Homeserver;
  request: Request;
  url: URL;
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Remote address, if known. */
  ip: string | null;
  /** Parsed JSON body (empty object when no body was sent). */
  json<T = any>(): Promise<T>;
  bytes(): Promise<Uint8Array>;
  /** Authenticate the request; throws M_MISSING_TOKEN / M_UNKNOWN_TOKEN. */
  auth(): Promise<Session>;
  /** Authenticate if a token was supplied. */
  optionalAuth(): Promise<Session | null>;
  accessToken(): string | null;
  /** Apply the rate limit for `action` to the requesting user (or IP when unauthenticated). */
  rateLimit(action: RateLimitAction): Promise<void>;
}
export type HandlerResult = Response | object | void;
/** What the router calls; endpoints build one with `procedure()` (see http/procedure.ts). */
export type Handler = (ctx: RequestContext) => Promise<HandlerResult> | HandlerResult;
export declare class Router {
  private routes;
  add(method: HttpMethod, path: string, handler: Handler): void;
  get: (path: string, h: Handler) => void;
  post: (path: string, h: Handler) => void;
  put: (path: string, h: Handler) => void;
  delete: (path: string, h: Handler) => void;
  /** Register a client-server API route under both `r0` and `v3` (or the given versions). */
  client(method: HttpMethod, path: string, handler: Handler, versions?: string[]): void;
  match(method: string, pathname: string): {
    handler: Handler;
    params: Record<string, string>;
  } | "method" | null;
}
//# sourceMappingURL=router.d.ts.map