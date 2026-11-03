import type { v } from "#core/vpm.ts";
import type { Session } from "#core/auth.ts";
import type { RateLimitAction } from "#core/ratelimit.ts";
import type { Handler, HandlerResult, RequestContext } from "#http/router.ts";
/**
 * Who may call the procedure: `"user"` needs an access token (`ctx.session`), `"optional"`
 * accepts one (`ctx.session` may be null), `"none"` does not look for one.
 */
export type AuthMode = "none" | "optional" | "user";
type SessionOf<A extends AuthMode> = A extends "user" ? Session : A extends "optional" ? Session | null : undefined;
type Parsed<S> = S extends v.Schema ? v.output<S> : undefined;
/** What a handler receives: the request context, plus the session, the guard's result and the parsed body. */
export type ProcedureContext<A extends AuthMode = "none", I = undefined, G = unknown> = RequestContext & G & {
    session: SessionOf<A>;
    input: I;
};
export interface ProcedureDef<A extends AuthMode, S extends v.Schema | undefined, O extends v.Schema | undefined, G extends object> {
    auth?: A;
    /** Runs instead of (or after) `auth`, and adds what it returns to the context. */
    guard?: (ctx: RequestContext) => Promise<G> | G;
    rateLimit?: RateLimitAction;
    input?: S;
    output?: O;
    handler: (ctx: ProcedureContext<A, Parsed<S>, G>) => Promise<O extends v.Schema ? v.input<O> | Response : HandlerResult> | (O extends v.Schema ? v.input<O> | Response : HandlerResult);
}
export declare function procedure<A extends AuthMode = "none", S extends v.Schema | undefined = undefined, O extends v.Schema | undefined = undefined, G extends object = {}>(def: ProcedureDef<A, S, O, G>): Handler;
export {};
