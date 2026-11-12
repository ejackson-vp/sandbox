/**
 * Shared store records for tests that seed a payment or a session.
 *
 * Deliberately narrow. Eleven copies of `sessionRecord` used three different
 * tiers, three durations and three limit profiles, so `tier`, `durationSeconds`
 * and `limits` are required here: a caller states its shape instead of
 * inheriting one. Only the fields every copy agreed on are defaulted.
 */
import type { SessionLimits, SessionTier } from "@x402s/shared/protocol";
import type { RuntimeName } from "@x402s/shared/runtimes";
import type { PaymentRecord, SessionRecord } from "../../controller/src/store/models.js";

export type LimitsProfile = "integration" | "unit" | "small";

/**
 * The three limit profiles the duplicated fixtures actually used.
 *
 * `integration` is the 500 millicore shape `operation-fencing.test.ts` uses.
 * Three other integration files use the same profile with `maxCommandSeconds:
 * 120`, which is why they keep a local literal rather than calling this.
 * `small` is the 64 process shape from `create-path.test.ts` and
 * `settlement-recovery.test.ts`.
 */
const PROFILES: Record<LimitsProfile, SessionLimits> = {
  integration: {
    cpuMillis: 500,
    memoryMiB: 512,
    diskMiB: 256,
    maxOutputBytes: 262_144,
    maxFileBytes: 8 * 1024 * 1024,
    maxCommandSeconds: 300,
    maxProcesses: 256,
  },
  unit: {
    cpuMillis: 1000,
    memoryMiB: 1024,
    diskMiB: 1024,
    maxOutputBytes: 262_144,
    maxFileBytes: 8 * 1024 * 1024,
    maxCommandSeconds: 300,
    maxProcesses: 256,
  },
  small: {
    cpuMillis: 500,
    memoryMiB: 512,
    diskMiB: 256,
    maxOutputBytes: 262_144,
    maxFileBytes: 8 * 1024 * 1024,
    maxCommandSeconds: 300,
    maxProcesses: 64,
  },
};

/** A fresh copy, so a caller that mutates the result cannot edit the profile. */
export function limitsFor(profile: LimitsProfile): SessionLimits {
  return { ...PROFILES[profile] };
}

export interface SessionFixtureInput {
  id: string;
  paymentKey: string;
  tier: SessionTier;
  durationSeconds: number;
  limits: SessionLimits;
  /**
   * Required because the copies disagreed: `"pk"`, `"pk-shared"`,
   * `"client-public-key"`, a per-id derivation, or a function argument.
   */
  clientPublicKey: string;
  /** Required for the same reason as `clientPublicKey`. */
  clientNonce: string;
  /** Clock for `createdAt`, `paidAt`, `updatedAt` and the one hour expiry. */
  now?: number;
  /**
   * Only written when supplied. `runtime` appeared in one copy and not the
   * others, and pre-v12 rows have no value, so there is no safe default.
   */
  runtime?: RuntimeName;
  /** Anything a test needs beyond the mechanical defaults below. */
  overrides?: Partial<SessionRecord>;
}

/**
 * A PAID session record with every mechanical field filled in. `state`,
 * `capabilityHash`, the null columns, `execEpoch: 1` and `destroyRequested: 0`
 * were identical in every copy, so they live here.
 */
export function sessionFixture(input: SessionFixtureInput): SessionRecord {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    capabilityHash: "a".repeat(64),
    capabilityExpiresAt: now + 3_600_000,
    clientPublicKey: input.clientPublicKey,
    clientNonce: input.clientNonce,
    clientSigner: null,
    tier: input.tier,
    durationSeconds: input.durationSeconds,
    limits: input.limits,
    state: "PAID",
    createdAt: now,
    paidAt: now,
    readyAt: null,
    leaseExpiresAt: null,
    terminatingAt: null,
    destroyedAt: null,
    terminationReason: null,
    failureCode: null,
    failureMessage: null,
    attestationJson: null,
    guestPublicKey: null,
    paymentKey: input.paymentKey,
    podName: null,
    runtimeClass: "x402-sandbox",
    executionMode: "dev",
    ...(input.runtime ? { runtime: input.runtime } : {}),
    relayTokenHash: null,
    activeRequestId: null,
    execEpoch: 1,
    relayPurgedAt: null,
    destroyRequested: 0,
    timingsJson: null,
    idlePolicyJson: null,
    maxLifetimeSeconds: null,
    suspendedAt: null,
    resumeCount: 0,
    lastActivityAt: null,
    workspacePvc: null,
    baselineCpuMillis: null,
    baselineMemoryMib: null,
    nodeName: null,
    updatedAt: now,
    ...input.overrides,
  };
}

export interface PaymentFixtureInput {
  paymentKey: string;
  /** Required because the copies used `"mock:local"`, `MOCK_NETWORK` and `"eip155:84532"`. */
  network: string;
  /**
   * No default: the four integration copies carry no payer, the unit copies
   * carry `0x...0001`, and the store contract takes a parameter. Omitted from
   * the record when not supplied, so the two shapes stay distinguishable.
   */
  payer?: string;
  /** No default, same reason as `payer`: absent in the integration copies. */
  transaction?: string;
  /** No default: only `settlement-recovery.test.ts` set it. */
  settlementNonce?: string | null;
}

/**
 * A mock-settled payment. `scheme`, `asset`, `amount`, `payTo` and `mode` were
 * byte-identical in every copy, so only the key and network are required.
 */
export function paymentFixture(input: PaymentFixtureInput): PaymentRecord {
  return {
    paymentKey: input.paymentKey,
    network: input.network,
    scheme: "exact",
    asset: "mock:usdc",
    amount: "50000",
    payTo: "0x0000000000000000000000000000000000000402",
    mode: "mock",
    ...(input.payer !== undefined ? { payer: input.payer } : {}),
    ...(input.transaction !== undefined ? { transaction: input.transaction } : {}),
    ...(input.settlementNonce !== undefined ? { settlementNonce: input.settlementNonce } : {}),
  };
}
