/**
 * The key, lease and retry half of the durable-call contract (ADR 0011).
 *
 * These are the decisions a reader should be able to check without a database:
 * what a key is made of, when a lease has expired, when a claim may be taken
 * over, and how long a retry waits. The SQL adapters only compare the values
 * produced here, and the property suite drives the same functions as a state
 * machine.
 */
import { describe, expect, it } from "vitest";
import {
  asClaimToken,
  backoffMs,
  claimDecision,
  claimLease,
  deadlinePassed,
  isExhausted,
  isExpired,
  isHeldBy,
  keyPrefix,
  leaseCoversCallTimeout,
  leaseCutoffMs,
  leaseExpiresAt,
  nextAttemptAtMs,
  operationKey,
  parseOperationKey,
  policyProblems,
  reclaim,
  reclaimable,
  refundKey,
  refundRetryPolicy,
  retryPolicy,
  settlementKey,
} from "@x402s/shared/durable";

const PAYMENT_KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

describe("operation keys", () => {
  it("is a pure function of the payment, per kind", () => {
    expect(refundKey(PAYMENT_KEY).value).toBe(`refund:${PAYMENT_KEY}`);
    expect(settlementKey(PAYMENT_KEY).value).toBe(`settlement:${PAYMENT_KEY}`);
    // Same payment, two operations: they must not dedupe against each other.
    expect(refundKey(PAYMENT_KEY).value).not.toBe(settlementKey(PAYMENT_KEY).value);
    // Two payments never share a key.
    expect(refundKey(OTHER_KEY).value).not.toBe(refundKey(PAYMENT_KEY).value);
    // Calling it twice is the whole point: a retry presents this exact string.
    expect(refundKey(PAYMENT_KEY)).toEqual(refundKey(PAYMENT_KEY));
  });

  it("keeps the prefix in one place for the SQL that has to build a key", () => {
    expect(keyPrefix("refund")).toBe("refund:");
    expect(keyPrefix("settlement")).toBe("settlement:");
    expect(refundKey(PAYMENT_KEY).value.startsWith(keyPrefix("refund"))).toBe(true);
  });

  it("round-trips and rejects anything a transport could mangle", () => {
    expect(parseOperationKey(refundKey(PAYMENT_KEY).value)).toEqual(refundKey(PAYMENT_KEY));
    expect(parseOperationKey(`settlement:${OTHER_KEY}`)).toEqual(settlementKey(OTHER_KEY));
    expect(parseOperationKey("refund:")).toBeNull();
    expect(parseOperationKey("nonsense:x")).toBeNull();
    expect(parseOperationKey(`refund:${"a".repeat(201)}`)).toBeNull();
    expect(parseOperationKey("refund:has space")).toBeNull();
    expect(() => operationKey("refund", "")).toThrow(/stable printable identity/);
    expect(() => operationKey("settle" as never, PAYMENT_KEY)).toThrow(/unknown operation kind/);
    expect(() => refundKey("line\nbreak")).toThrow();
    // Header-safe by construction, including the colon separator.
    expect(refundKey(PAYMENT_KEY).value).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe("claim leases", () => {
  const token = asClaimToken("f".repeat(32));
  const lease = claimLease(token, 1_000, 500);

  it("expires at the deadline, half-open", () => {
    expect(leaseExpiresAt(lease)).toBe(1_500);
    expect(isExpired(lease, 1_499)).toBe(false);
    expect(isExpired(lease, 1_500)).toBe(true);
  });

  it("treats an unowned row as reclaimable and a live one as not", () => {
    expect(reclaimable(null, 0)).toBe(true);
    expect(reclaimable(lease, 1_000)).toBe(false);
    expect(reclaimable(lease, 1_500)).toBe(true);
  });

  it("refuses to take over a live lease and issues a new token otherwise", () => {
    const next = asClaimToken("e".repeat(32));
    expect(() => reclaim(lease, next, 1_000, 500)).toThrow(/live lease/);
    const keyBefore = refundKey(PAYMENT_KEY).value;
    const taken = reclaim(lease, next, 1_600, 500);
    expect(taken.token).toBe(next);
    expect(taken.claimedAtMs).toBe(1_600);
    // A reclaim is a new owner and a new deadline, not a new operation name.
    expect(refundKey(PAYMENT_KEY).value).toBe(keyBefore);
  });

  it("derives the query cutoff and the absolute deadline from the same arithmetic", () => {
    expect(leaseCutoffMs(10_000, 2_000)).toBe(8_000);
    expect(deadlinePassed(1_000, 999)).toBe(false);
    expect(deadlinePassed(1_000, 1_000)).toBe(true);
    // No recorded deadline is due, not stuck: the refund query's NULL branch.
    expect(deadlinePassed(null, 0)).toBe(true);
  });

  it("only lets the token holder record a result", () => {
    expect(isHeldBy(token, token)).toBe(true);
    expect(isHeldBy(token, asClaimToken("0".repeat(32)))).toBe(false);
    expect(isHeldBy(null, token)).toBe(false);
    expect(isHeldBy("", "")).toBe(false);
  });

  it("refuses a token that is not an opaque printable fence", () => {
    expect(() => asClaimToken("short")).toThrow();
    expect(() => asClaimToken("has space in it")).toThrow();
    // A 128-bit hex fence is the shape the worker generates.
    expect(asClaimToken("c".repeat(32))).toBe("c".repeat(32));
  });
});

describe("claim decision", () => {
  const token = asClaimToken("d".repeat(32));
  const policy = { maxAttempts: 3 };

  it("claims work nobody owns and is due", () => {
    expect(claimDecision({ attempts: 0, nextAttemptAtMs: null, lease: null }, 0, policy)).toBe("claim");
    expect(claimDecision({ attempts: 0, nextAttemptAtMs: 1_000, lease: null }, 1_000, policy)).toBe("claim");
  });

  it("waits out a backoff that has not elapsed", () => {
    expect(claimDecision({ attempts: 1, nextAttemptAtMs: 1_000, lease: null }, 999, policy)).toBe("not_due");
  });

  it("reclaims an expired lease, but not a live one", () => {
    const lease = claimLease(token, 0, 1_000);
    expect(claimDecision({ attempts: 1, nextAttemptAtMs: 0, lease }, 500, policy)).toBe("not_due");
    expect(claimDecision({ attempts: 1, nextAttemptAtMs: 0, lease }, 1_000, policy)).toBe("reclaim");
  });

  it("never claims work at the attempt limit, even with an expired lease", () => {
    const lease = claimLease(token, 0, 1_000);
    expect(claimDecision({ attempts: 3, nextAttemptAtMs: null, lease: null }, 0, policy)).toBe("exhausted");
    expect(claimDecision({ attempts: 3, nextAttemptAtMs: null, lease }, 9_999, policy)).toBe("exhausted");
  });
});

describe("retry policy", () => {
  const policy = retryPolicy({ maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 500, leaseMs: 30_000 });

  it("backs off exponentially from the base delay and stops at the ceiling", () => {
    expect(backoffMs(policy, 0)).toBe(100);
    expect(backoffMs(policy, 1)).toBe(200);
    expect(backoffMs(policy, 2)).toBe(400);
    expect(backoffMs(policy, 3)).toBe(500);
    // A huge attempt count must not overflow into Infinity or a non-integer.
    expect(backoffMs(policy, 1_024)).toBe(500);
    expect(backoffMs(policy, -1)).toBe(100);
  });

  it("turns a refusal into the next due time using the same clock as the query", () => {
    expect(retryPolicy().baseDelayMs).toBe(60_000);
    expect(nextAttemptAtMs(policy, 0, 10_000)).toBe(10_100);
    expect(nextAttemptAtMs(policy, 2, 10_000)).toBe(10_400);
    expect(isExhausted(policy, 4)).toBe(true);
  });

  it("reports exhaustion monotonically", () => {
    expect(isExhausted(policy, 0)).toBe(false);
    expect(isExhausted(policy, 3)).toBe(false);
    expect(isExhausted(policy, 4)).toBe(true);
    expect(isExhausted(policy, 99)).toBe(true);
  });

  it("rejects a policy whose lease is shorter than the call timeout", () => {
    expect(leaseCoversCallTimeout(policy)).toBe(true);
    expect(leaseCoversCallTimeout(retryPolicy({ leaseMs: 5_000, callTimeoutMs: 5_000 }))).toBe(false);
    expect(policyProblems(retryPolicy())).toEqual([]);
    expect(() => retryPolicy({ maxAttempts: 0 })).toThrow(/maxAttempts/);
    expect(() => retryPolicy({ baseDelayMs: 10, maxDelayMs: 5 })).toThrow(/maxDelayMs/);
    // The worker's adapter keeps its own defaults for the optional fields.
    expect(refundRetryPolicy({ maxAttempts: 2, baseDelayMs: 1_000 })).toMatchObject({
      maxAttempts: 2,
      baseDelayMs: 1_000,
      maxDelayMs: 3_600_000,
      leaseMs: 60_000,
    });
  });
});
