/** A rate limiter keyed by an arbitrary string. Implement this to share limits across instances. */
export interface RateLimiter {
    /** Consume one unit for `key` under `rule`; resolve with the delay to wait (0 when allowed). */
    consume(key: string, rule: RateLimitRule): Promise<number>;
}
export interface RateLimitRule {
    /** Sustained requests per second. */
    perSecond: number;
    /** Burst size. */
    burst: number;
}
export type RateLimitAction = "login" | "register" | "message" | "join" | "invite" | "upload" | "createRoom" | "keyQuery" | "oauthClient" | "preview";
export declare const DEFAULT_RATE_LIMITS: Record<RateLimitAction, RateLimitRule>;
/** In-process token bucket limiter. */
export declare function memoryRateLimiter(): RateLimiter;
export declare class RateLimits {
    private limiter;
    private rules;
    constructor(limiter: RateLimiter | null, overrides?: Partial<Record<RateLimitAction, RateLimitRule>>);
    /** Throw M_LIMIT_EXCEEDED when `key` exceeded the limit for `action`. Exempt keys are never limited. */
    check(action: RateLimitAction, key: string): Promise<void>;
}
