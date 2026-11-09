import { describe, expect, it } from "vitest";
import { RateLimiter, paymentPayerKey } from "../../api/src/admission.js";

describe("admission control", () => {
  it("gives each key its own bucket", () => {
    const limiter = new RateLimiter(2, 1);
    expect(limiter.take("payer:a")).toBe(true);
    expect(limiter.take("payer:a")).toBe(true);
    expect(limiter.take("payer:a")).toBe(false);
    // A different payer is unaffected by the first payer's burst.
    expect(limiter.take("payer:b")).toBe(true);
  });

  it("reports a retry delay for an empty bucket", () => {
    const limiter = new RateLimiter(1, 1);
    expect(limiter.take("payer:a")).toBe(true);
    expect(limiter.take("payer:a")).toBe(false);
    expect(limiter.retryAfterSeconds("payer:a")).toBeGreaterThanOrEqual(1);
    expect(limiter.retryAfterSeconds("payer:never-seen")).toBe(0);
  });

  it("keys by the EIP-3009 payer and normalizes case", () => {
    const payload = { payload: { authorization: { from: "0xAbCdEf0000000000000000000000000000000001" } } };
    expect(paymentPayerKey(payload, "10.0.0.1")).toBe("payer:0xabcdef0000000000000000000000000000000001");
  });

  it("falls back to the source IP when the payload has no payer", () => {
    expect(paymentPayerKey({ payload: {} }, "10.0.0.1")).toBe("ip:10.0.0.1");
    expect(paymentPayerKey({ payload: { authorization: { from: "not-an-address" } } }, "10.0.0.2")).toBe(
      "ip:10.0.0.2",
    );
    expect(paymentPayerKey(undefined, "10.0.0.3")).toBe("ip:10.0.0.3");
  });
});

describe("rate limiter eviction", () => {
  it("does not reset an exhausted bucket when unrelated keys overflow the table", () => {
    // Small table so the attack is cheap to express; production uses 10k.
    const limiter = new RateLimiter(1, 0.001, 8);
    expect(limiter.take("payer:victim")).toBe(true);
    expect(limiter.take("payer:victim")).toBe(false);

    for (let i = 0; i < 200; i += 1) {
      limiter.take(`payer:attacker-${i}`);
    }

    // The victim is still rate limited: a full-table clear would have reset it.
    expect(limiter.take("payer:victim")).toBe(false);
    expect(limiter.retryAfterSeconds("payer:victim")).toBeGreaterThan(0);
  });

  it("keeps the number of buckets bounded", () => {
    const limiter = new RateLimiter(1, 0.001, 16);
    for (let i = 0; i < 500; i += 1) limiter.take(`payer:${i}`);
    // New keys keep working (the table is bounded, not wedged).
    expect(limiter.take("payer:fresh")).toBe(true);
    expect(limiter.take("payer:fresh")).toBe(false);
  });
});
