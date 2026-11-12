/**
 * The outcome algebra and the `runClaimed` orchestration (ADR 0011).
 *
 * The classification table is the part that decides whether money can be
 * retried, so it is pinned case by case. `runClaimed` is then pinned on which
 * callback it calls, and which it must not: an unknown outcome and a lost fence
 * both write nothing.
 */
import { describe, expect, it, vi } from "vitest";
import {
  classifyStatus,
  classifyThrown,
  countsAsAttempt,
  definiteFailure,
  failureOf,
  isDefiniteFailure,
  isOk,
  isUnknown,
  mapOutcome,
  ok,
  retryDecision,
  retryPolicy,
  runClaimed,
  toFailure,
  unknown,
  valueOf,
  type ClaimedCall,
  type ExternalOutcome,
} from "@x402s/shared/durable";

describe("outcome algebra", () => {
  it("keeps the three cases apart", () => {
    expect(isOk(ok(7))).toBe(true);
    expect(isDefiniteFailure(definiteFailure("refused"))).toBe(true);
    expect(isUnknown(unknown("timeout"))).toBe(true);
    expect(valueOf(ok({ transaction: "0x1" }))).toEqual({ transaction: "0x1" });
    expect(valueOf(definiteFailure("x"))).toBeNull();
    expect(failureOf(unknown("timeout"))).toEqual({ reason: "timeout" });
    expect(mapOutcome(ok(2), (n) => n * 3)).toEqual(ok(6));
    expect(mapOutcome(unknown("x"), (n: number) => n * 3)).toEqual(unknown("x"));
  });

  it("only a definite refusal consumes the attempt budget", () => {
    expect(countsAsAttempt(ok(null))).toBe(false);
    expect(countsAsAttempt(unknown("timeout"))).toBe(false);
    expect(countsAsAttempt(definiteFailure("refused"))).toBe(true);
  });

  it("classifies HTTP statuses conservatively", () => {
    for (const status of [200, 201, 204, 299]) expect(classifyStatus(status)).toBe("ok");
    for (const status of [400, 401, 402, 403, 404, 409, 422, 499]) {
      expect(classifyStatus(status)).toBe("definite_failure");
    }
    // Ambiguous by definition: the provider did not answer, or asked us to
    // come back, or the answer was not a completed transfer.
    for (const status of [408, 425, 429, 500, 502, 503, 504, 301, 302, 100, 0, 600]) {
      expect(classifyStatus(status)).toBe("unknown");
    }
  });

  it("never reads a throw as a refusal", () => {
    const outcome = classifyThrown(new Error("socket hang up"));
    expect(outcome).toEqual(unknown("socket hang up"));
    expect(isUnknown(outcome)).toBe(true);
    expect(toFailure(new Error(""))).toEqual({ reason: "external call failed without a message" });
    expect(toFailure("plain string")).toEqual({ reason: "plain string" });
  });
});

describe("runClaimed", () => {
  const policy = retryPolicy({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, leaseMs: 30_000 });
  const nowMs = 1_000_000;

  function harness(overrides: {
    outcome?: () => Promise<ExternalOutcome<string>>;
    complete?: (value: string) => Promise<boolean>;
    fail?: (failure: { reason: string }, retry: { attempts: number }) => Promise<boolean>;
    attemptsSoFar?: number;
  }) {
    const complete = vi.fn(overrides.complete ?? (async () => true));
    const fail = vi.fn(overrides.fail ?? (async () => true));
    const call = vi.fn(overrides.outcome ?? (async () => ok("tx-1")));
    return {
      complete,
      fail,
      call,
      work: {
        policy,
        attemptsSoFar: overrides.attemptsSoFar ?? 0,
        nowMs,
        call,
        complete,
        fail,
      } satisfies ClaimedCall<string>,
    };
  }

  it("completes once when the provider answered", async () => {
    const h = harness({});
    const result = await runClaimed(h.work);
    expect(result).toEqual({ kind: "completed", value: "tx-1" });
    expect(h.complete).toHaveBeenCalledWith("tx-1");
    expect(h.fail).not.toHaveBeenCalled();
  });

  it("reports a lost completion without pretending it succeeded", async () => {
    const h = harness({ complete: async () => false });
    const result = await runClaimed(h.work);
    expect(result).toEqual({ kind: "claim_lost", stage: "complete", value: "tx-1" });
    expect(h.fail).not.toHaveBeenCalled();
  });

  it("reports a failed record without releasing the claim", async () => {
    const h = harness({
      complete: async () => {
        throw new Error("ledger write failed");
      },
    });
    const result = await runClaimed(h.work);
    expect(result).toEqual({
      kind: "record_failed",
      failure: { reason: "ledger write failed" },
      value: "tx-1",
    });
    // The compensation is the lease reclaim with the same key, not a release.
    expect(h.fail).not.toHaveBeenCalled();
  });

  it("hands a refusal a retry decision and releases only through the callback", async () => {
    const h = harness({ outcome: async () => definiteFailure("treasury offline"), attemptsSoFar: 1 });
    const result = await runClaimed(h.work);
    expect(result).toMatchObject({
      kind: "refused",
      failure: { reason: "treasury offline" },
      retry: { attempts: 2, exhausted: false, nextAttemptAtMs: nowMs + 200 },
    });
    expect(h.fail).toHaveBeenCalledTimes(1);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("marks the refusal that reaches the limit as exhausted", async () => {
    const h = harness({ outcome: async () => definiteFailure("refused"), attemptsSoFar: 2 });
    const result = await runClaimed(h.work);
    expect(result).toMatchObject({ kind: "refused", retry: { attempts: 3, exhausted: true } });
  });

  it("records nothing for an unknown outcome, so the budget is untouched", async () => {
    const h = harness({ outcome: async () => unknown("timeout"), attemptsSoFar: 2 });
    const result = await runClaimed(h.work);
    expect(result).toEqual({ kind: "unknown", failure: { reason: "timeout" } });
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.fail).not.toHaveBeenCalled();
  });

  it("treats a thrown call as unknown and still writes nothing", async () => {
    const h = harness({
      outcome: async () => {
        throw new Error("socket hang up");
      },
    });
    const result = await runClaimed(h.work);
    expect(result).toEqual({ kind: "unknown", failure: { reason: "socket hang up" } });
    expect(h.fail).not.toHaveBeenCalled();
  });

  it("reports a lost release with the failure it tried to record", async () => {
    const h = harness({
      outcome: async () => definiteFailure("treasury offline"),
      fail: async () => false,
    });
    const result = await runClaimed(h.work);
    expect(result).toEqual({
      kind: "claim_lost",
      stage: "fail",
      failure: { reason: "treasury offline" },
    });
  });

  it("computes the retry decision from the policy, not from a clock read", () => {
    expect(retryDecision(policy, 0, nowMs)).toEqual({
      attempts: 1,
      exhausted: false,
      nextAttemptAtMs: nowMs + 100,
    });
    expect(retryDecision(policy, 2, nowMs)).toMatchObject({ attempts: 3, exhausted: true });
  });
});
