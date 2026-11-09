/**
 * Admission control primitives.
 *
 * Two buckets guard session creation:
 *   - a coarse per-source-IP bucket before the payment is decoded (anti-abuse),
 *   - a per-payer bucket after the payment payload is decoded but before the
 *     payment is claimed or settled (fairness for a paid, multi-tenant API).
 *
 * The payer key comes from the unverified EIP-3009 authorization. That is fine
 * for rate limiting (it is not a trust decision): an attacker who spoofs the
 * `from` field only moves their own bucket, and the IP bucket still bounds the
 * total. The verified payer is recorded separately on the payment.
 */

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number; seq: number }>();
  private readonly maxBuckets: number;
  private seq = 0;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    maxBuckets = 10_000,
  ) {
    this.maxBuckets = maxBuckets;
  }

  take(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updated: now, seq: 0 };
    const elapsed = (now - b.updated) / 1000;
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
   * Bounded eviction instead of clearing the table. A full clear let an
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
    const now = Date.now();
    const tokens = Math.min(this.capacity, b.tokens + ((now - b.updated) / 1000) * this.refillPerSecond);
    if (tokens >= 1) return 0;
    return Math.max(1, Math.ceil((1 - tokens) / this.refillPerSecond));
  }
}

/**
 * Best-effort payer identity from an x402 payment payload. Falls back to the
 * source IP for schemes that do not carry an `authorization.from`.
 */
export function paymentPayerKey(payload: unknown, ip: string): string {
  const p = payload as { payload?: Record<string, unknown> } | undefined;
  const auth = p?.payload?.authorization as { from?: unknown } | undefined;
  if (typeof auth?.from === "string" && /^0x[0-9a-fA-F]{40}$/.test(auth.from)) {
    return `payer:${auth.from.toLowerCase()}`;
  }
  return `ip:${ip}`;
}
