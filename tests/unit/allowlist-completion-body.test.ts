/**
 * The free (allowlist) completion body must satisfy the controller's schema.
 *
 * This is the shape a paid request never produces: `amount: "0"`, `source:
 * "allowlist"`, no transaction and no settlement nonce, because nothing settled.
 * The schema accepts all of that except an explicit `null`, and sending null for
 * the absent nonce failed the whole body as `invalid_request` after the
 * entitlement had been granted. Every allowlisted create answered 400.
 *
 * The allowlist ships disabled, so nothing exercised this path until the feature
 * was switched on in the hosted deployment.
 */
import { describe, expect, it } from "vitest";
import { completeSchema } from "../../controller/src/control-api-schemas.js";

const SPEC = {
  tier: "short",
  runtime: "base",
  durationSeconds: 60,
  limits: {
    cpuMillis: 500, memoryMiB: 512, diskMiB: 256,
    maxOutputBytes: 262144, maxFileBytes: 8388608,
    maxCommandSeconds: 300, maxProcesses: 256,
  },
  maxLifetimeSeconds: 3600,
  idlePolicy: { maxIdleSeconds: 60, suspendedDurationSeconds: 60, autoResume: true },
  baseline: { cpuMillis: 250, memoryMiB: 256 },
};

function body(extra: Record<string, unknown>) {
  return {
    claimToken: "a1".repeat(16),
    sessionId: `sbx_${"a".repeat(24)}`,
    capabilityHash: "b".repeat(64),
    capabilityExpiresAt: Date.now() + 60_000,
    spec: SPEC,
    clientPublicKey: "c".repeat(44),
    clientNonce: "d".repeat(44),
    timings: { apiReceivedAt: 1, paymentVerifyMs: 0, paymentSettleMs: 0, entitlementMs: 1 },
    payment: {
      paymentKey: "e".repeat(64),
      network: "eip155:8453",
      scheme: "exact",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "20000",
      payTo: "0x51B15E8eB232eA82B1060c635C64Cd311fDE3348",
      mode: "mainnet",
      ...extra,
    },
  };
}

describe("completion body", () => {
  it("accepts the free-session shape, which omits the settlement nonce", () => {
    const result = completeSchema.safeParse(
      body({
        amount: "0",
        source: "allowlist",
        payer: "0x679192A3c1ca70708177e5Bb9E6378711802033d",
        label: "operator-smoke-test",
        budgetKey: "allow:0x679192a3c1ca70708177e5bb9e6378711802033d",
      }),
    );
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("rejects an explicit null nonce, which is the bug this pins", () => {
    const result = completeSchema.safeParse(
      body({ amount: "0", source: "allowlist", settlementNonce: null }),
    );
    expect(result.success).toBe(false);
  });

  it("still accepts a paid body carrying a real nonce", () => {
    const result = completeSchema.safeParse(
      body({ settlementNonce: "0x" + "f".repeat(64), source: "x402" }),
    );
    expect(result.success).toBe(true);
  });
});
