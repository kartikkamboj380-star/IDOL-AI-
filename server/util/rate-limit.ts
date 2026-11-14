/** Sliding-window rate limiter (per client key), used for API endpoints. */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export class RateLimiter {
  private buckets = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
    private readonly maxKeys = 5000,
  ) {}

  consume(key: string, now = Date.now()): RateLimitResult {
    const windowStart = now - this.windowMs;
    let entries = this.buckets.get(key);
    if (!entries) {
      if (this.buckets.size >= this.maxKeys) this.evict(now);
      entries = [];
      this.buckets.set(key, entries);
    }
    while (entries.length > 0 && (entries[0] as number) < windowStart) entries.shift();
    if (entries.length >= this.maxRequests) {
      const oldest = entries[0] as number;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
      };
    }
    entries.push(now);
    return { allowed: true, remaining: this.maxRequests - entries.length, retryAfterSeconds: 0 };
  }

  private evict(now: number): void {
    const windowStart = now - this.windowMs;
    for (const [key, entries] of this.buckets) {
      const last = entries[entries.length - 1];
      if (last === undefined || last < windowStart) this.buckets.delete(key);
    }
    if (this.buckets.size >= this.maxKeys) {
      // Still full: drop the oldest insertion order entry to bound memory.
      const firstKey = this.buckets.keys().next().value;
      if (firstKey !== undefined) this.buckets.delete(firstKey);
    }
  }
}
