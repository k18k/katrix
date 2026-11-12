import { MatrixError } from "./errors.js";
// src/core/ratelimit.ts
const DEFAULT_RATE_LIMITS = {
	login: {
		perSecond: .17,
		burst: 5
	},
	register: {
		perSecond: .17,
		burst: 3
	},
	message: {
		perSecond: 1,
		burst: 20
	},
	join: {
		perSecond: .5,
		burst: 10
	},
	invite: {
		perSecond: .3,
		burst: 10
	},
	upload: {
		perSecond: 1,
		burst: 10
	},
	createRoom: {
		perSecond: .1,
		burst: 5
	},
	keyQuery: {
		perSecond: 5,
		burst: 50
	},
	oauthClient: {
		perSecond: .5,
		burst: 10
	},
	preview: {
		perSecond: .5,
		burst: 10
	}
};
/** In-process token bucket limiter. */
function memoryRateLimiter() {
	const buckets = /* @__PURE__ */ new Map();
	return { async consume(key, rule) {
		const now = Date.now();
		let b = buckets.get(key);
		if (!b) {
			if (buckets.size > 1e5) buckets.clear();
			buckets.set(key, b = {
				tokens: rule.burst,
				updated: now
			});
		}
		b.tokens = Math.min(rule.burst, b.tokens + (now - b.updated) / 1e3 * rule.perSecond);
		b.updated = now;
		if (b.tokens >= 1) {
			b.tokens -= 1;
			return 0;
		}
		return Math.ceil((1 - b.tokens) / rule.perSecond * 1e3);
	} };
}
var RateLimits = class {
	limiter;
	rules;
	constructor(limiter, overrides = {}) {
		this.limiter = limiter;
		this.rules = {
			...DEFAULT_RATE_LIMITS,
			...overrides
		};
	}
	/** Throw M_LIMIT_EXCEEDED when `key` exceeded the limit for `action`. Exempt keys are never limited. */
	async check(action, key) {
		if (!this.limiter) return;
		const wait = await this.limiter.consume(`${action}:${key}`, this.rules[action]);
		if (wait > 0) throw new MatrixError(429, "M_LIMIT_EXCEEDED", "Too many requests", { retry_after_ms: wait });
	}
};
export { DEFAULT_RATE_LIMITS, RateLimits, memoryRateLimiter };

//# sourceMappingURL=ratelimit.js.map