export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

interface Counter {
  count: number;
  resetAt: number;
}

export interface FixedWindowRateLimiterOptions {
  windowMs: number;
  limit: number;
  maxKeys?: number;
}

export class FixedWindowRateLimiter {
  readonly #counters = new Map<string, Counter>();
  readonly #windowMs: number;
  readonly #limit: number;
  readonly #maxKeys: number;

  constructor(options: FixedWindowRateLimiterOptions) {
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
      throw new TypeError("windowMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new TypeError("limit must be a positive safe integer");
    }
    if (options.maxKeys !== undefined && (!Number.isSafeInteger(options.maxKeys) || options.maxKeys < 1)) {
      throw new TypeError("maxKeys must be a positive safe integer");
    }
    this.#windowMs = options.windowMs;
    this.#limit = options.limit;
    this.#maxKeys = options.maxKeys ?? 10_000;
  }

  consume(key: string, now = Date.now()): RateLimitDecision {
    const normalizedKey = key || "unknown";
    let counter = this.#counters.get(normalizedKey);
    if (!counter || counter.resetAt <= now) {
      if (!counter && this.#counters.size >= this.#maxKeys) this.#prune(now);
      if (!counter && this.#counters.size >= this.#maxKeys) {
        return {
          allowed: false,
          limit: this.#limit,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil(this.#windowMs / 1_000)),
        };
      }
      counter = { count: 0, resetAt: now + this.#windowMs };
      this.#counters.set(normalizedKey, counter);
    }

    counter.count += 1;
    return {
      allowed: counter.count <= this.#limit,
      limit: this.#limit,
      remaining: Math.max(0, this.#limit - counter.count),
      retryAfterSeconds: Math.max(1, Math.ceil((counter.resetAt - now) / 1_000)),
    };
  }

  clear(key?: string): void {
    if (key === undefined) this.#counters.clear();
    else this.#counters.delete(key || "unknown");
  }

  #prune(now: number): void {
    for (const [key, counter] of this.#counters) {
      if (counter.resetAt <= now) this.#counters.delete(key);
    }
  }
}
