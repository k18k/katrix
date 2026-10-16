import { errors } from "../core/errors.ts";
import type { Homeserver } from "../homeserver.ts";
import type { Session } from "../core/auth.ts";
import type { RateLimitAction } from "../core/ratelimit.ts";
import type { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RequestContext<I = unknown> {
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
  /**
   * The request body parsed with the route's `input` schema (undefined for routes without one).
   * Validated on first access, which throws the Matrix error for an invalid body: read it where
   * the handler needs the body, after authenticating.
   */
  input: I;
}

export type HandlerResult = Response | object | void;
export type Handler<I = any> = (ctx: RequestContext<I>) => Promise<HandlerResult> | HandlerResult;

/** Per-route options. `input` validates and parses the JSON body before the handler runs. */
export interface RouteOptions<S extends z.ZodType = z.ZodType> {
  input?: S;
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  input?: z.ZodType;
}

/** A route's handler, with the body type its `input` schema produces. */
type Routed<S> = S extends z.ZodType ? Handler<z.output<S>> : Handler;

export class Router {
  private routes: Route[] = [];

  add<S extends z.ZodType | undefined = undefined>(
    method: HttpMethod,
    path: string,
    handler: Routed<S>,
    options: RouteOptions<NonNullable<S>> = {},
  ): void {
    this.routes.push({ method, segments: path.split("/").filter(Boolean), handler: handler as Handler, input: options.input });
  }

  get(path: string, h: Handler): void {
    this.add("GET", path, h);
  }
  post<S extends z.ZodType>(path: string, options: RouteOptions<S>, h: Routed<S>): void;
  post(path: string, h: Handler): void;
  post(path: string, a: RouteOptions | Handler, b?: Handler): void {
    if (typeof a === "function") this.add("POST", path, a);
    else this.add("POST", path, b!, a);
  }
  put<S extends z.ZodType>(path: string, options: RouteOptions<S>, h: Routed<S>): void;
  put(path: string, h: Handler): void;
  put(path: string, a: RouteOptions | Handler, b?: Handler): void {
    if (typeof a === "function") this.add("PUT", path, a);
    else this.add("PUT", path, b!, a);
  }
  delete(path: string, h: Handler): void {
    this.add("DELETE", path, h);
  }

  /** Register a client-server API route under both `r0` and `v3` (or the given versions). */
  client<S extends z.ZodType>(method: HttpMethod, path: string, options: RouteOptions<S>, handler: Routed<S>, versions?: string[]): void;
  client(method: HttpMethod, path: string, handler: Handler, versions?: string[]): void;
  client(method: HttpMethod, path: string, a: RouteOptions | Handler, b?: Handler | string[], c?: string[]): void {
    const [options, handler, versions] =
      typeof a === "function" ? [{}, a, (b as string[] | undefined) ?? ["r0", "v3"]] : [a, b as Handler, c ?? ["r0", "v3"]];
    for (const v of versions) this.add(method, `/_matrix/client/${v}${path}`, handler, options);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string>; input?: z.ZodType } | "method" | null {
    const parts = pathname.split("/").filter(Boolean);
    let methodMismatch = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      if (route.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { handler: route.handler, params, input: route.input };
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
      try {
        params[seg.slice(1)] = decodeURIComponent(parts[i]);
      } catch {
        return null;
      }
    } else if (seg !== parts[i]) {
      return null;
    }
  }
  return segments.length === parts.length ? params : null;
}

export function notFound(): never {
  throw errors.unrecognized();
}
