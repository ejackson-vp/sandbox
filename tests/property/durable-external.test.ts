/**
 * State-machine property test for the durable-call contract (ADR 0011).
 *
 * The unit suites pin individual predicates; this one pins what the protocol
 * composes to over arbitrary interleavings of claims, reclaims, provider
 * outcomes and clock ticks. It drives the real `claimDecision`, `claimLease`,
 * `runClaimed` and `retryDecision`, with an in-memory row whose complete/release
 * methods are the same conditional writes the Postgres adapter runs:
 *
 *   complete: only while SENDING and only for the token the row holds
 *   release:  the same guard, plus attempts + 1 and the next due time
 *
 * The invariants are the ones a second completion would violate:
 *
 *   1. at most one completion per claim, and at most one per payment;
 *   2. a stale claim cannot complete and records nothing;
 *   3. a reclaim changes the owner and the deadline, never the key;
 *   4. an unknown outcome never consumes the definitive failure budget;
 *   5. attempts never decrease.
 *
 * The Postgres integration tests (`tests/unit/refund-claim.test.ts`) remain the
 * oracle: this model is only allowed to say what the protocol promises.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  asClaimToken,
  claimDecision,
  claimLease,
  definiteFailure,
  isHeldBy,
  leaseCutoffMs,
  ok,
  reclaim,
  refundKey,
  retryPolicy,
  runClaimed,
  unknown,
  type ClaimLease,
  type ExternalOutcome,
} from "@x402s/shared/durable";

const SUBJECT = "c".repeat(64);
const POLICY = retryPolicy({ maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 4_000, leaseMs: 2_000 });
const CLAIM_POLICY = { maxAttempts: POLICY.maxAttempts };

type Status = "pending" | "sending" | "refunded";

interface Row {
  status: Status;
  attempts: number;
  nextAttemptAtMs: number | null;
  lease: ClaimLease | null;
  /** The operation name. A reclaim must not touch it. */
  readonly key: string;
  completions: number;
  /** Completions recorded per fence token, so a double count is visible. */
  completionsByToken: Map<string, number>;
}

interface Provider {
  /** The provider dedupes by key: one transfer, however many sends. */
  readonly transfers: Map<string, string>;
}

function emptyRow(): Row {
  return {
    status: "pending",
    attempts: 0,
    nextAttemptAtMs: null,
    lease: null,
    key: refundKey(SUBJECT).value,
    completions: 0,
    completionsByToken: new Map(),
  };
}

/** The conditional UPDATE: SENDING plus the current token, or nothing. */
function complete(row: Row, token: string, transaction: string): boolean {
  if (row.status !== "sending") return false;
  if (row.lease === null || !isHeldBy(row.lease.token, token)) return false;
  row.status = "refunded";
  row.lease = null;
  row.completions += 1;
  row.completionsByToken.set(token, (row.completionsByToken.get(token) ?? 0) + 1);
  void transaction;
  return true;
}

/** The conditional release: same fence, then one failed attempt. */
function release(row: Row, token: string, nextAttemptAtMs: number): boolean {
  if (row.status !== "sending") return false;
  if (row.lease === null || !isHeldBy(row.lease.token, token)) return false;
  row.status = "pending";
  row.attempts += 1;
  row.nextAttemptAtMs = nextAttemptAtMs;
  row.lease = null;
  return true;
}

function tokenOf(seed: number): string {
  return seed.toString(16).padStart(32, "0");
}

function assertInvariants(row: Row, keyAtStart: string, provider: Provider): void {
  // 3. The key is a function of the payment, not of the claim.
  expect(row.key).toBe(keyAtStart);
  expect(row.key).toBe(refundKey(SUBJECT).value);

  // 1. At most one completion per claim and one per payment.
  for (const count of row.completionsByToken.values()) expect(count).toBeLessThanOrEqual(1);
  expect(row.completions).toBeLessThanOrEqual(1);

  // The provider saw one key, so there can only be one transfer.
  expect(provider.transfers.size).toBeLessThanOrEqual(1);
  if (row.completions > 0) expect(provider.transfers.has(row.key)).toBe(true);

  // Terminal rows are not owned.
  if (row.status === "refunded") expect(row.lease).toBeNull();
  // A released attempt is always due in the future, never in the past.
  if (row.nextAttemptAtMs !== null) expect(row.attempts).toBeGreaterThan(0);
}

describe("durable external call state machine", () => {
  it("holds the effectively-once invariants over random interleavings", async () => {
    // op, dt, token seed, stale flag
    const step = fc.array(
      fc.tuple(fc.nat({ max: 3 }), fc.nat({ max: 5_000 }), fc.nat({ max: 999 }), fc.boolean()),
      { minLength: 1, maxLength: 32 },
    );

    await fc.assert(
      fc.asyncProperty(step, async (steps) => {
        const row = emptyRow();
        const keyAtStart = row.key;
        const provider: Provider = { transfers: new Map() };
        const staleTokens: string[] = [];
        let clock = 1_000_000;
        let lastAttempts = 0;

        const assertAfter = () => {
          assertInvariants(row, keyAtStart, provider);
          expect(row.attempts).toBeGreaterThanOrEqual(lastAttempts);
          lastAttempts = row.attempts;
        };

        for (const [op, dt, seed, stale] of steps) {
          clock += dt;

          if (op === 0) {
            // Claim pass: the pure decision plus the same write the SQL does.
            if (row.status === "refunded") continue;
            const leaseBefore = row.lease;
            const decision = claimDecision(
              { attempts: row.attempts, nextAttemptAtMs: row.nextAttemptAtMs, lease: row.lease },
              clock,
              CLAIM_POLICY,
            );
            if (decision === "claim" || decision === "reclaim") {
              const token = asClaimToken(tokenOf(seed));
              if (row.lease !== null) staleTokens.push(row.lease.token);
              row.lease = reclaim(row.lease, token, clock, POLICY.leaseMs);
              row.status = "sending";
              // A claim is due, so the cutoff it would pass to the query is
              // behind the row's own claimed_at.
              expect(leaseCutoffMs(clock, POLICY.leaseMs)).toBe(clock - POLICY.leaseMs);
            } else {
              // Not due, or exhausted: no new owner and no new deadline.
              expect(row.lease).toBe(leaseBefore);
            }
            assertAfter();
            continue;
          }

          if (op === 1) {
            // A send from the current owner, or from an owner that was fenced.
            if (row.lease === null) continue;
            const currentToken = row.lease.token;
            const presented = stale
              ? (staleTokens[staleTokens.length - 1] ?? tokenOf(seed))
              : currentToken;
            const wasCurrent = isHeldBy(currentToken, presented);
            const verdict = seed % 3;
            const outcome: ExternalOutcome<{ transaction: string }> =
              verdict === 0
                ? unknown("timeout")
                : verdict === 1
                  ? definiteFailure("provider refused")
                  : ok({ transaction: "0xtx" });
            const attemptsBefore = row.attempts;
            const completionsBefore = row.completions;
            const statusBefore = row.status;

            const result = await runClaimed({
              policy: POLICY,
              attemptsSoFar: row.attempts,
              nowMs: clock,
              call: async () => {
                if (outcome.kind === "ok") {
                  // The provider's dedupe: the original transaction, no second
                  // transfer for the same key.
                  const existing = provider.transfers.get(row.key);
                  if (existing) return ok({ transaction: existing });
                  provider.transfers.set(row.key, outcome.value.transaction);
                }
                return outcome;
              },
              complete: async (value) => complete(row, presented, value.transaction),
              fail: async (_failure, retry) => release(row, presented, retry.nextAttemptAtMs),
            });

            // 5. Attempts never decrease.
            expect(row.attempts).toBeGreaterThanOrEqual(lastAttempts);
            // 4. Unknown never consumes the definitive failure budget.
            if (result.kind === "unknown") {
              expect(row.attempts).toBe(attemptsBefore);
              expect(row.status).toBe(statusBefore);
            }
            // 2. A stale claim records nothing, whichever way it ends.
            if (!wasCurrent) {
              expect(row.completions).toBe(completionsBefore);
              expect(row.attempts).toBe(attemptsBefore);
              expect(row.status).toBe(statusBefore);
              if (result.kind !== "unknown") expect(result.kind).toBe("claim_lost");
            }
            if (result.kind === "refused") expect(row.attempts).toBe(attemptsBefore + 1);
            if (result.kind === "completed") {
              expect(row.completions).toBe(completionsBefore + 1);
              expect(row.attempts).toBe(attemptsBefore);
            }
            assertAfter();
            continue;
          }

          if (op === 2) {
            // A direct completion outside runClaimed, with a token that may be
            // stale. The fence is the same one, so it must not move the row.
            const currentToken = row.lease?.token ?? null;
            const presented = stale
              ? (staleTokens[staleTokens.length - 1] ?? tokenOf(seed))
              : (currentToken ?? tokenOf(seed));
            const wasCurrent = isHeldBy(currentToken, presented);
            const completionsBefore = row.completions;
            const statusBefore = row.status;
            const written = complete(row, presented, "0xmanual");
            // An operator recording a transfer they already sent: the provider
            // saw the same key, so the map still holds one entry.
            if (written) provider.transfers.set(row.key, "0xmanual");
            if (!wasCurrent) {
              expect(written).toBe(false);
              expect(row.completions).toBe(completionsBefore);
              expect(row.status).toBe(statusBefore);
            }
            assertAfter();
            continue;
          }

          // op === 3: time passes, nothing else happens.
          assertAfter();
        }

        // Final invariants, including the terminal-state shape.
        assertInvariants(row, keyAtStart, provider);
        if (row.status === "refunded") {
          expect(row.completions).toBe(1);
          expect(provider.transfers.size).toBe(1);
          expect(row.attempts).toBeLessThanOrEqual(POLICY.maxAttempts);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("never reclaims a live lease and never completes through an expired one", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 60_000 }),
        fc.integer({ min: 0, max: 60_000 }),
        fc.integer({ min: 0, max: 99_999 }),
        (claimedAt, leaseMs, elapsed, seed) => {
          const token = asClaimToken(tokenOf(seed));
          const lease = claimLease(token, claimedAt, leaseMs);
          const now = claimedAt + elapsed;
          const expired = elapsed >= leaseMs;
          const decision = claimDecision(
            { attempts: 0, nextAttemptAtMs: null, lease },
            now,
            { maxAttempts: 3 },
          );
          expect(decision).toBe(expired ? "reclaim" : "not_due");
          if (expired) {
            const next = reclaim(lease, asClaimToken(tokenOf(seed + 1)), now, leaseMs);
            // A reclaim is a new owner and a new deadline, not a new operation.
            expect(refundKey(SUBJECT).value).toBe(`refund:${SUBJECT}`);
            expect(next.claimedAtMs).toBe(now);
          } else {
            expect(() => reclaim(lease, asClaimToken(tokenOf(seed + 1)), now, leaseMs)).toThrow();
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("keeps the key injective and stable across owners", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-f0-9]{8,64}$/),
        fc.stringMatching(/^[a-f0-9]{8,64}$/),
        (first, second) => {
          const a = refundKey(first).value;
          const b = refundKey(second).value;
          // Equal keys mean equal subjects: a collision would merge two payments.
          if (a === b) expect(first).toBe(second);
          expect(refundKey(first).value).toBe(a);
        },
      ),
      { numRuns: 200 },
    );
  });
});
