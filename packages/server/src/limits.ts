export interface HubLimits {
  /** Failed authentications per IP per minute before a lockout. */
  authFailuresPerMinute: number;
  /** Sustained requests per device per minute (token bucket refill). */
  requestsPerMinute: number;
  /** Bucket size (burst) per device. */
  burst: number;
  /** Max devices per account (selfhost: unlimited). */
  maxDevicesPerAccount: number;
}

export const DEFAULT_LIMITS: HubLimits = {
  authFailuresPerMinute: 10,
  requestsPerMinute: 300,
  burst: 300,
  maxDevicesPerAccount: Number.POSITIVE_INFINITY,
};

/** Per-IP failed-auth counter with exponential lockout (1 min, 2 min, ... max 1 h). */
export class FailureLimiter {
  private readonly entries = new Map<string, { count: number; windowStart: number; strikes: number; blockedUntil: number }>();
  private readonly maxPerMinute: number;

  constructor(maxPerMinute: number) {
    this.maxPerMinute = maxPerMinute;
  }

  isBlocked(ip: string, now = Date.now()): boolean {
    return (this.entries.get(ip)?.blockedUntil ?? 0) > now;
  }

  fail(ip: string, now = Date.now()): void {
    const e = this.entries.get(ip) ?? { count: 0, windowStart: now, strikes: 0, blockedUntil: 0 };
    if (now - e.windowStart > 60_000) {
      e.count = 0;
      e.windowStart = now;
    }
    e.count += 1;
    if (e.count >= this.maxPerMinute) {
      e.strikes += 1;
      e.blockedUntil = now + Math.min(3_600_000, 60_000 * 2 ** (e.strikes - 1));
      e.count = 0;
    }
    this.entries.delete(ip);
    this.entries.set(ip, e); // re-insert: Map order = least recently failed first
    if (this.entries.size > 100_000) this.evict(now);
  }

  /** Memory guard against address spraying: drop expired entries, then the oldest unblocked ones; active lockouts stay. */
  private evict(now: number): void {
    for (const [ip, e] of this.entries) {
      if (e.blockedUntil <= now && now - e.windowStart > 60_000) this.entries.delete(ip);
    }
    for (const [ip, e] of this.entries) {
      if (this.entries.size <= 90_000) break;
      if (e.blockedUntil <= now) this.entries.delete(ip);
    }
  }
}

/** Token bucket per key (device id). */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly capacity: number;
  private readonly perMs: number;

  constructor(perMinute: number, burst: number) {
    this.capacity = burst;
    this.perMs = perMinute / 60_000;
  }

  take(key: string, now = Date.now()): boolean {
    if (!Number.isFinite(this.capacity)) return true;
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * this.perMs);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}
