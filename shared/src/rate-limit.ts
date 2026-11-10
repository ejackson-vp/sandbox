/**
 * Bounded in-memory token bucket, shared by the public API admission paths and
 * the controller/relay internal listeners.
 *
 * The table is bounded deliberately: an attacker who can rotate keys must not
 * be able to grow process memory without limit, and must not reset a live
 * penalty by overflowing the table. The current key always survives eviction;
 * unpenalized keys are dropped before penalized ones.
 *
 * This is per-process state. It bounds one pod, not a fleet; a shared limiter is
 * a separate production-readiness item.
 */
import { metrics, type MetricsRegistry } from "./metrics.js";
import { recordRateLimited, type RateLimitScope } from "./request-metrics.js";

export interface TokenBucketOptions {
  /** Maximum tokens (burst) per key. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
  /** Maximum live keys. Old/unpenalized keys are evicted past this. */
  maxBuckets?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; updated: number; seq: number }>();
  private readonly maxBuckets: number;
  private readonly now: () => number;
  private seq = 0;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    maxBuckets = 10_000,
    now: () => number = Date.now,
  ) {
    if (!Number.isFinite(capacity) || capacity < 1) throw new Error("capacity must be >= 1");
    if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
      throw new Error("refillPerSecond must be > 0");
    }
    if (!Number.isInteger(maxBuckets) || maxBuckets < 1) throw new Error("maxBuckets must be >= 1");
    this.maxBuckets = maxBuckets;
    this.now = now;
  }

  /** Number of live keys. Exposed for the bounded-state test. */
  size(): number {
    return this.buckets.size;
  }

  take(key: string): boolean {
    const now = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updated: now, seq: 0 };
    const elapsed = Math.max(0, (now - b.updated) / 1000);
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSecond);
    b.updated = now;
    b.seq = ++this.seq;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      this.evict(now, key);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    this.evict(now, key);
    return true;
  }

  /**
   * Bounded eviction instead of clearing the table. A full clear would let an
   * attacker reset every other key's penalty (including a victim's) by
   * presenting `maxBuckets` unique keys. Here the current key is always the
   * most recently touched, so it survives, and buckets with no remaining
   * penalty are dropped before any penalized bucket.
   */
  private evict(now: number, keep: string): void {
    if (this.buckets.size <= this.maxBuckets) return;
    // Trim to 90% so a sustained flood pays the scan once per ~10% of the
    // table, not once per request.
    const target = Math.max(1, Math.floor(this.maxBuckets * 0.9));
    for (const [key, b] of this.buckets) {
      if (this.buckets.size <= target) return;
      if (key === keep) continue;
      const tokens = Math.min(this.capacity, b.tokens + ((now - b.updated) / 1000) * this.refillPerSecond);
      if (tokens >= this.capacity) this.buckets.delete(key);
    }
    if (this.buckets.size <= target) return;
    // Everything left carries a penalty. Evict the newest first: a burst of
    // fresh keys must not displace a limit that is already doing its job.
    const scored = [...this.buckets.entries()]
      .filter(([key]) => key !== keep)
      .map(([key, b]) => ({ key, seq: b.seq }));
    scored.sort((a, b) => b.seq - a.seq);
    for (const { key } of scored) {
      if (this.buckets.size <= target) break;
      this.buckets.delete(key);
    }
  }

  /** Whole seconds until the key has one token; 0 when it can proceed now. */
  retryAfterSeconds(key: string): number {
    const b = this.buckets.get(key);
    if (!b) return 0;
    const now = this.now();
    const tokens = Math.min(this.capacity, b.tokens + ((now - b.updated) / 1000) * this.refillPerSecond);
    if (tokens >= 1) return 0;
    return Math.max(1, Math.ceil((1 - tokens) / this.refillPerSecond));
  }
}

/** Burst/refill used by the authenticated in-cluster control listeners. */
export const INTERNAL_RATE_LIMIT: TokenBucketOptions = {
  capacity: 5_000,
  refillPerSecond: 2_000,
  maxBuckets: 1_024,
};

export interface RateLimitRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
}

export interface RateLimitResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}

export type RateLimitNext = (err?: unknown) => void;

/**
 * Express-compatible middleware over a bounded token bucket.
 *
 * The key is the socket peer address (Express `req.ip` with no trusted proxy
 * configured for these in-cluster listeners), never a header. The 429 body and
 * the metric scope are closed enums; no caller input reaches either.
 */
export function rateLimit(
  bucket: TokenBucket,
  scope: RateLimitScope,
  registry: MetricsRegistry = metrics,
) {
  return (req: RateLimitRequest, res: RateLimitResponse, next: RateLimitNext): void => {
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    if (bucket.take(key)) {
      next();
      return;
    }
    recordRateLimited(scope, registry);
    res.setHeader("Retry-After", String(bucket.retryAfterSeconds(key)));
    res.status(429).json({ error: "rate_limited", scope });
  };
}

