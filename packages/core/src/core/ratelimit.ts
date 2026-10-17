import { MatrixError } from "#core/errors.ts";

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

export type RateLimitAction = "login" | "register" | "message" | "join" | "invite" | "upload" | "createRoom" | "keyQuery" | "oauthClient";

export const DEFAULT_RATE_LIMITS: Record<RateLimitAction, RateLimitRule> = {
  login: { perSecond: 0.17, burst: 5 },
  register: { perSecond: 0.17, burst: 3 },
  message: { perSecond: 1, burst: 20 },
  join: { perSecond: 0.5, burst: 10 },
  invite: { perSecond: 0.3, burst: 10 },
  upload: { perSecond: 1, burst: 10 },
  createRoom: { perSecond: 0.1, burst: 5 },
  keyQuery: { perSecond: 5, burst: 50 },
  // OAuth 2.0 client registration: clients register again at every login.
  oauthClient: { perSecond: 0.5, burst: 10 },
};

/** In-process token bucket limiter. */
export function memoryRateLimiter(): RateLimiter {
  const buckets = new Map<string, { tokens: number; updated: number }>();
  return {
    async consume(key, rule) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b) {
        if (buckets.size > 100_000) buckets.clear();
        buckets.set(key, (b = { tokens: rule.burst, updated: now }));
      }
      b.tokens = Math.min(rule.burst, b.tokens + ((now - b.updated) / 1000) * rule.perSecond);
      b.updated = now;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return 0;
      }
      return Math.ceil(((1 - b.tokens) / rule.perSecond) * 1000);
    },
  };
}

export class RateLimits {
  private limiter: RateLimiter | null;
  private rules: Record<RateLimitAction, RateLimitRule>;

  constructor(limiter: RateLimiter | null, overrides: Partial<Record<RateLimitAction, RateLimitRule>> = {}) {
    this.limiter = limiter;
    this.rules = { ...DEFAULT_RATE_LIMITS, ...overrides };
  }

  /** Throw M_LIMIT_EXCEEDED when `key` exceeded the limit for `action`. Exempt keys are never limited. */
  async check(action: RateLimitAction, key: string): Promise<void> {
    if (!this.limiter) return;
    const wait = await this.limiter.consume(`${action}:${key}`, this.rules[action]);
    if (wait > 0) throw new MatrixError(429, "M_LIMIT_EXCEEDED", "Too many requests", { retry_after_ms: wait });
  }
}
