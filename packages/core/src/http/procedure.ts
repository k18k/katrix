import type { z } from "zod";
import type { Session } from "#core/auth.ts";
import type { RateLimitAction } from "#core/ratelimit.ts";
import { inputError } from "#http/input.ts";
import type { Handler, HandlerResult, RequestContext } from "#http/router.ts";

// Procedures: an endpoint is declared as what it needs (authentication, a rate limit, a body
// schema, optionally a response schema) plus a handler. The procedure runs those steps in a fixed
// order and hands the handler a context with the results injected, so every endpoint checks its
// requests the same way:
//
//   1. authentication (`auth`), or the caller's own check (`guard`, e.g. federation signatures)
//   2. rate limit (`rateLimit`)
//   3. body (`input`, a zod schema)
//   4. the handler
//   5. response (`output`, a zod schema; responses that are already a `Response` pass as they are)
//
// The order matters: a request without credentials is refused with 401 before its body is looked
// at, and a rate-limited caller gets 429 without the server parsing anything.

/**
 * Who may call the procedure: `"user"` needs an access token (`ctx.session`), `"optional"`
 * accepts one (`ctx.session` may be null), `"none"` does not look for one.
 */
export type AuthMode = "none" | "optional" | "user";

type SessionOf<A extends AuthMode> = A extends "user" ? Session : A extends "optional" ? Session | null : undefined;
type Parsed<S> = S extends z.ZodType ? z.output<S> : undefined;

/** What a handler receives: the request context, plus the session, the guard's result and the parsed body. */
export type ProcedureContext<A extends AuthMode = "none", I = undefined, G = unknown> = RequestContext &
  G & {
    session: SessionOf<A>;
    input: I;
  };

export interface ProcedureDef<A extends AuthMode, S extends z.ZodType | undefined, O extends z.ZodType | undefined, G extends object> {
  auth?: A;
  /** Runs instead of (or after) `auth`, and adds what it returns to the context. */
  guard?: (ctx: RequestContext) => Promise<G> | G;
  rateLimit?: RateLimitAction;
  input?: S;
  output?: O;
  handler: (
    ctx: ProcedureContext<A, Parsed<S>, G>,
  ) => Promise<O extends z.ZodType ? z.input<O> | Response : HandlerResult> | (O extends z.ZodType ? z.input<O> | Response : HandlerResult);
}

export function procedure<
  A extends AuthMode = "none",
  S extends z.ZodType | undefined = undefined,
  O extends z.ZodType | undefined = undefined,
  G extends object = {},
>(def: ProcedureDef<A, S, O, G>): Handler {
  return async (ctx: RequestContext) => {
    const session = def.auth === "user" ? await ctx.auth() : def.auth === "optional" ? await ctx.optionalAuth() : undefined;
    const extra = def.guard ? await def.guard(ctx) : ({} as G);
    if (def.rateLimit) await ctx.rateLimit(def.rateLimit);
    let input: unknown;
    if (def.input) {
      const parsed = def.input.safeParse(await ctx.json());
      if (!parsed.success) throw inputError(parsed.error);
      input = parsed.data;
    }
    const result = await def.handler(Object.assign(ctx, extra, { session, input }) as ProcedureContext<A, Parsed<S>, G>);
    if (!def.output || result instanceof Response) return result as HandlerResult;
    // A response that does not match its schema is a server bug: fail loudly rather than send it.
    const checked = def.output.safeParse(result);
    if (!checked.success) throw new Error(`Response does not match the output schema: ${checked.error.message}`);
    return checked.data as HandlerResult;
  };
}
