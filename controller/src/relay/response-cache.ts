/**
 * The per-session response cache.
 *
 * A retry must be answerable after the guest is done with the operation, so the
 * relay keeps the last answers. This is the only unbounded-by-nature structure
 * in the registry: a long-lived session that runs thousands of operations would
 * grow the process, so a TTL and an entry cap are enforced on every write and on
 * every read that could observe an expired entry.
 *
 * Answers and errors share the cap and the TTL but never the same id: a request
 * id is answered once, and a second answer is reported as a duplicate rather
 * than overwriting the first.
 */
import type { RelayFailureCode } from "./results.js";

/** Entries kept per session; the oldest is evicted first (`Map` is ordered). */
const MAX_CACHED_RESPONSES = 64;

interface CachedResponse {
  envelope: string;
  at: number;
}

interface CachedError {
  code: RelayFailureCode;
  message: string;
  at: number;
}

export class ResponseCache {
  private readonly responses = new Map<string, CachedResponse>();
  private readonly errors = new Map<string, CachedError>();

  constructor(private readonly ttlMs: number) {}

  /** Whether this id already has an answer: a retry returns it, not a resend. */
  has(id: string): boolean {
    return this.responses.has(id) || this.errors.has(id);
  }

  response(id: string): CachedResponse | undefined {
    return this.responses.get(id);
  }

  error(id: string): { code: RelayFailureCode; message: string } | undefined {
    const cached = this.errors.get(id);
    return cached ? { code: cached.code, message: cached.message } : undefined;
  }

  remember(id: string, envelope: string, now: number): void {
    this.responses.set(id, { envelope, at: now });
    this.expire(now);
  }

  rememberError(id: string, code: RelayFailureCode, message: string, now: number): void {
    this.errors.set(id, { code, message, at: now });
    this.expire(now);
  }

  /** Drop expired entries, then the oldest until the cache fits. */
  expire(now: number): void {
    for (const [id, value] of this.responses) {
      if (now - value.at > this.ttlMs) this.responses.delete(id);
    }
    for (const [id, value] of this.errors) {
      if (now - value.at > this.ttlMs) this.errors.delete(id);
    }
    this.trim(this.responses);
    this.trim(this.errors);
  }

  private trim(cache: Map<string, { at: number }>): void {
    while (cache.size > MAX_CACHED_RESPONSES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
}
