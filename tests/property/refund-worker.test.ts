/**
 * Property tests for the refund worker loop (ADR 0011, docs/payment-ledger.md).
 *
 * `tests/property/durable-external.test.ts` pins the protocol's pure algebra:
 * claim, lease, retry decision and `runClaimed`. This file puts the real
 * `RefundWorker` on top of that model. The store is an in-memory adapter whose
 * four methods are the same conditional writes the Postgres adapter runs, and
 * whose claim rule is the shared `claimDecision`, so the class under test is the
 * production one: the real policy object, the real `runClaimed`, the real
 * executor classification.
 *
 * The invariants are the ones a wrong worker loses money on. An unknown
 * provider outcome never consumes the definitive failure budget, because that
 * is how work that may already have paid gets abandoned. A stale claim token
 * never completes and records nothing. A payment completes at most once, and
 * never through a fence it no longer holds. Attempts never decrease and never
 * exceed the limit, the backoff is exponential from the base and capped, and a
 * row at the limit is left in `REFUND_PENDING` for an operator instead of being
 * retried forever. Every attempt for a row presents the same idempotency key,
 * so the provider can only have moved funds once.
 *
 * The HTTP executor's own contract, and the edge cases a corrupted claim
 * produces, are in tests/property/refund-worker-executor.test.ts.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { asClaimToken, backoffMs, refundRetryPolicy } from "@x402s/shared/durable";
import { RefundWorker, type RefundExecutor } from "../../controller/src/refund-worker.js";
import {
  KEY,
  MemoryLedger,
  POLICY_SHAPE,
  pendingRow,
  policyOf,
  provider,
  type Verdict,
} from "../helpers/memory-refund-ledger.js";

describe("refund worker claim/complete/retry loop", () => {
  it("never spends the failure budget on an unknown outcome", async () => {
    const step = fc.record({
      dt: fc.integer({ min: 0, max: 5_000 }),
      verdict: fc.constantFrom<Verdict>("ok", "refuse", "unknown"),
    });

    await fc.assert(
      fc.asyncProperty(
        POLICY_SHAPE,
        fc.array(step, { minLength: 1, maxLength: 20 }),
        async (shape, steps) => {
          const policy = policyOf(shape);
          const ledger = new MemoryLedger(pendingRow(KEY, 1_000_000));
          let clock = 1_000_000;
          let lastAttempts = 0;

          for (const { dt, verdict } of steps) {
            clock += dt;
            const executor = provider(ledger, () => verdict);
            const worker = new RefundWorker(ledger, executor, {
              maxAttempts: policy.maxAttempts,
              retryBaseMs: policy.baseDelayMs,
              retryMaxMs: policy.maxDelayMs,
              claimLeaseMs: policy.leaseMs,
              callTimeoutMs: policy.callTimeoutMs,
              limit: 10,
              now: () => clock,
            });
            const before = { ...ledger.row() };
            const beforeSends = executor.calls.length;
            const result = await worker.run();
            const after = ledger.row();

            // Attempts only ever move forward, and never past the limit.
            expect(after.refundAttempts).toBeGreaterThanOrEqual(lastAttempts);
            expect(after.refundAttempts).toBeLessThanOrEqual(policy.maxAttempts);
            lastAttempts = after.refundAttempts;

            if (result.attempted === 0) {
              // Not due, or already at the limit: nothing was sent.
              expect(executor.calls.length).toBe(beforeSends);
            }

            if (result.unknown === 1) {
              // Unknown is not a refusal: no attempt, no release, and the row
              // stays owned until the lease makes it due again.
              expect(after.refundAttempts).toBe(before.refundAttempts);
              expect(after.refundNextAttemptAt).toBe(before.refundNextAttemptAt);
              expect(after.status).toBe("REFUND_SENDING");
            }

            if (result.failed === 1 || result.exhausted === 1) {
              expect(after.refundAttempts).toBe(before.refundAttempts + 1);
              expect(after.status).toBe("REFUND_PENDING");
              expect(after.refundClaimToken).toBeNull();
              expect(after.refundNextAttemptAt).not.toBeNull();
              // Exponential from the base, never above the ceiling.
              const expected = Math.min(
                policy.maxDelayMs,
                policy.baseDelayMs * 2 ** before.refundAttempts,
              );
              expect(after.refundNextAttemptAt! - clock).toBe(expected);
              expect(after.refundNextAttemptAt! - clock).toBeLessThanOrEqual(policy.maxDelayMs);
              if (result.exhausted === 1) {
                expect(after.refundAttempts).toBe(policy.maxAttempts);
              }
            }

            if (result.refunded === 1) {
              expect(after.status).toBe("REFUNDED");
              expect(after.refundTransaction).not.toBeNull();
              expect(after.refundClaimToken).toBeNull();
              // One payment, one transfer: every send used the stable key.
              expect(ledger.transfers.size).toBe(1);
              expect(after.refundAttempts).toBeLessThanOrEqual(policy.maxAttempts);
            }

            // The provider only ever saw this payment's key.
            for (const call of executor.calls) {
              expect(call.idempotencyKey).toBe(`refund:${KEY}`);
              expect(call.paymentKey).toBe(KEY);
            }
          }

          // At the limit the row is left for an operator: a pass a day later
          // cannot claim it again, and it stays visible as PENDING.
          clock += 86_400_000;
          const attemptsBeforeFinal = ledger.row().refundAttempts;
          const finalExecutor = provider(ledger, () => "refuse");
          const finalPass = await new RefundWorker(ledger, finalExecutor, {
            maxAttempts: policy.maxAttempts,
            retryBaseMs: policy.baseDelayMs,
            retryMaxMs: policy.maxDelayMs,
            claimLeaseMs: policy.leaseMs,
            callTimeoutMs: policy.callTimeoutMs,
            limit: 10,
            now: () => clock,
          }).run();
          const final = ledger.row();
          if (attemptsBeforeFinal >= policy.maxAttempts) {
            expect(finalPass.attempted).toBe(0);
            expect(finalExecutor.calls).toHaveLength(0);
            expect(final.status).toBe("REFUND_PENDING");
          }
          // Every release wrote exactly one attempt, and a row at the limit was
          // never released past it.
          expect(final.refundAttempts).toBe(ledger.releases.length);
        },
      ),
      { numRuns: 120 },
    );
  });

  it("lets a stale owner complete nothing, and records one completion per payment", async () => {
    const round = fc.record({
      dt: fc.integer({ min: 0, max: 5_000 }),
      current: fc.constantFrom<Verdict>("ok", "refuse", "unknown"),
      racer: fc.constantFrom<Verdict>("ok", "refuse", "unknown"),
    });

    await fc.assert(
      fc.asyncProperty(
        POLICY_SHAPE,
        fc.array(round, { minLength: 1, maxLength: 12 }),
        async (shape, rounds) => {
          const policy = policyOf(shape);
          const ledger = new MemoryLedger(pendingRow(KEY, 1_000_000));
          let clock = 1_000_000;
          const staleTokens: string[] = [];
          let lastAttempts = 0;

          for (const { dt, current, racer } of rounds) {
            clock += dt;
            const staleExecutor = provider(ledger, () => current);
            // The executor runs while this pass owns the row. It advances the
            // clock past the lease and lets a second worker take over, which is
            // exactly the interleaving the fence exists for.
            const racingExecutor: RefundExecutor = {
              async refund(request) {
                const answer = await staleExecutor.refund(request);
                const held = ledger.row().refundClaimToken;
                // Claim the row for a new owner, or retire it, past the lease.
                clock += policy.leaseMs + 1;
                await new RefundWorker(ledger, provider(ledger, () => racer), {
                  maxAttempts: policy.maxAttempts,
                  retryBaseMs: policy.baseDelayMs,
                  retryMaxMs: policy.maxDelayMs,
                  claimLeaseMs: policy.leaseMs,
                  callTimeoutMs: policy.callTimeoutMs,
                  limit: 10,
                  now: () => clock,
                }).run();
                // Only a token that is no longer the row's is a stale fence. A
                // row at the attempt limit is not reclaimable, so its owner is
                // still current and its completion is a legitimate one.
                if (held && held !== ledger.row().refundClaimToken) staleTokens.push(held);
                return answer;
              },
            };

            const before = { ...ledger.row() };
            await new RefundWorker(ledger, racingExecutor, {
              maxAttempts: policy.maxAttempts,
              retryBaseMs: policy.baseDelayMs,
              retryMaxMs: policy.maxDelayMs,
              claimLeaseMs: policy.leaseMs,
              callTimeoutMs: policy.callTimeoutMs,
              limit: 10,
              now: () => clock,
            }).run();
            const after = ledger.row();

            // Attempts never decrease.
            expect(after.refundAttempts).toBeGreaterThanOrEqual(lastAttempts);
            expect(after.refundAttempts).toBeGreaterThanOrEqual(before.refundAttempts);
            lastAttempts = after.refundAttempts;

            // At most one completion per payment, and never two for one token.
            const tokens = ledger.completions.map((completion) => completion.token);
            expect(new Set(tokens).size).toBe(tokens.length);
            expect(ledger.completions.length).toBeLessThanOrEqual(1);
            if (ledger.completions.length === 1) {
              expect(after.status).toBe("REFUNDED");
              expect(after.refundTransaction).toBe(ledger.transfers.get(`refund:${KEY}`));
            }

            // A token from an earlier owner can never complete or release, and
            // the refusal writes nothing.
            for (const stale of staleTokens) {
              const completionsBefore = ledger.completions.length;
              const releasesBefore = ledger.releases.length;
              const snapshot = { ...ledger.row() };
              expect(await ledger.completeRefundClaim(KEY, asClaimToken(stale), "0xstale")).toBe(
                false,
              );
              expect(await ledger.releaseRefundClaim(KEY, asClaimToken(stale), "stale", clock)).toBe(
                false,
              );
              expect(ledger.completions.length).toBe(completionsBefore);
              expect(ledger.releases.length).toBe(releasesBefore);
              expect(ledger.row()).toEqual(snapshot);
            }
          }

          // The key never changed, and one payment can only have moved funds
          // once however many rounds sent it.
          expect(ledger.transfers.size).toBeLessThanOrEqual(1);
          expect(ledger.row().paymentKey).toBe(KEY);
          expect(ledger.row().refundAttempts).toBeLessThanOrEqual(policy.maxAttempts);
        },
      ),
      { numRuns: 80 },
    );
  });

  it("keeps the backoff exponential, capped, and safe at absurd attempt counts", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 20_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (baseDelayMs, maxDelayMs, attempts) => {
          const policy = refundRetryPolicy({
            maxAttempts: 10,
            baseDelayMs,
            maxDelayMs: Math.max(maxDelayMs, baseDelayMs),
            leaseMs: 10,
            callTimeoutMs: 1,
          });
          const delay = backoffMs(policy, attempts);
          expect(delay).toBeLessThanOrEqual(policy.maxDelayMs);
          expect(delay).toBeGreaterThanOrEqual(0);
          // The closed form, with the clamp: 2 ** n overflows long before the
          // ceiling matters, and the result must stay a safe integer.
          const expected = Math.min(
            policy.maxDelayMs,
            policy.baseDelayMs * 2 ** Math.floor(attempts),
          );
          expect(delay).toBe(Number.isFinite(expected) ? expected : policy.maxDelayMs);
          expect(Number.isSafeInteger(delay)).toBe(true);
          // Non-decreasing in the attempt count.
          expect(backoffMs(policy, attempts + 1)).toBeGreaterThanOrEqual(delay);
        },
      ),
      { numRuns: 300 },
    );
  });
});
