import { errors } from "../core/errors.ts";
import type { Homeserver } from "../homeserver.ts";
import type { Session } from "../core/auth.ts";
import type { RateLimitAction } from "../core/ratelimit.ts";

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
export type Handler = (ctx: RequestContext) => Promise<HandlerResult> | HandlerResult;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: HttpMethod, path: string, handler: Handler): void {
    this.routes.push({ method, segments: path.split("/").filter(Boolean), handler });
  }

  get = (path: string, h: Handler) => this.add("GET", path, h);
  post = (path: string, h: Handler) => this.add("POST", path, h);
  put = (path: string, h: Handler) => this.add("PUT", path, h);
  delete = (path: string, h: Handler) => this.add("DELETE", path, h);

  /** Register a client-server API route under both `r0` and `v3`. */
  client(method: HttpMethod, path: string, handler: Handler, versions = ["r0", "v3"]): void {
    for (const v of versions) this.add(method, `/_matrix/client/${v}${path}`, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | "method" | null {
    const parts = pathname.split("/").filter(Boolean);
    let methodMismatch = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      if (route.method !== method) { methodMismatch = true; continue; }
      return { handler: route.handler, params };
    }
    return methodMismatch ? "method" : null;
  }
}

function matchSegments(segments: string[], parts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.startsWith("*")) {
      // Greedy wildcard: consumes the rest of the path.
      params[seg.slice(1)] = parts.slice(i).map(decodeURIComponent).join("/");
      return params;
    }
    if (i >= parts.length) return null;
    if (seg.startsWith(":")) {
      try { params[seg.slice(1)] = decodeURIComponent(parts[i]); } catch { return null; }
    } else if (seg !== parts[i]) {
      return null;
    }
  }
  return segments.length === parts.length ? params : null;
}

export function notFound(): never {
  throw errors.unrecognized();
}
