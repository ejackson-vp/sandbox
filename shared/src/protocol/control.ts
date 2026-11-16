/**
 * Internal control-plane contract (API server <-> controller).
 *
 * One declaration per body, and both sides import it: the API parses these
 * types, the controller produces them, and `tests/unit/control-contract.test.ts`
 * fails if either workspace grows its own copy again. The closed unions are
 * derived from a `const` array, so a new member is a compile error in every
 * exhaustive switch and, in the same edit, the new value of a metric label.
 */
import type {
  IdlePolicy,
  SessionLimits,
  SessionSpec,
  SessionState,
  SessionTier,
} from "./lifecycle.js";
import type { AttestationEnvelope } from "./attestation.js";
import type { PaymentMode, PaymentSummary, SessionTimings } from "./session.js";

/** Controller -> API session view. One definition; both sides import it. */
export interface ControllerSessionView {
  sessionId: string;
  state: SessionState;
  tier: SessionTier;
  durationSeconds: number;
  limits: SessionLimits;
  /** Guest runtime profile (`base`, `python`, `node`). */
  runtime?: string;
  createdAt: number;
  paidAt?: number;
  readyAt?: number;
  leaseExpiresAt?: number;
  remainingSeconds: number;
  terminatingAt?: number;
  destroyedAt?: number;
  clientNonce: string;
  clientPublicKey: string;
  capabilityHash: string;
  capabilityExpiresAt: number;
  guestPublicKey?: string;
  attestation?: AttestationEnvelope;
  suspendedAt?: number;
  resumeCount?: number;
  maxLifetimeSeconds?: number;
  idlePolicy?: IdlePolicy;
  baseline?: { cpuMillis: number; memoryMiB: number };
  failureCode?: string;
  failureMessage?: string;
  runtimeClass?: string;
  executionMode?: "dev" | "kata";
  busy: boolean;
  timings?: SessionTimings;
  payment: Omit<PaymentSummary, "priceUsd"> & { paymentKey: string };
}

export interface EntitlementRequest {
  sessionId: string;
  capabilityHash: string;
  capabilityExpiresAt: number;
  spec: SessionSpec;
  clientPublicKey: string;
  clientNonce: string;
  /** Wallet that signed the client commitment (the payment authoriser). */
  clientSigner?: string;
  payment: {
    paymentKey: string;
    network: string;
    scheme: string;
    asset: string;
    amount: string;
    payTo: string;
    payer?: string;
    transaction?: string;
    mode: PaymentMode;
    /** EIP-3009 authorisation nonce, so a refund can be keyed by it (#31). */
    settlementNonce?: string | null;
    /**
     * `x402` for a settled payment; `allowlist` for a $0 entitlement granted to
     * a proven allowlisted address (ADR 0013).
     */
    source?: "x402" | "allowlist";
    /** Operator label of the allowlist entry; recorded in the ledger's reason. */
    label?: string;
    /** Budget row to charge: `allow:<address>` for a free session. */
    budgetKey?: string;
  };
}


export interface PaymentIntentStatus {
  status: "claimed" | "pending" | "settled" | "failed";
  sessionId?: string;
  reason?: string;
}

/** One component of a readiness report. */
export interface ComponentHealth {
  ok: boolean;
  /**
   * Stable, bounded reason code. Never an exception message: those can carry
   * connection strings, file paths or other operational detail.
   */
  reason?: string;
}

/** Body of `GET /internal/readyz`, which the API reads before routing work. */
export interface ReadinessReport {
  ok: boolean;
  checkedAt: number;
  /** True when the report came from the TTL cache instead of a fresh probe. */
  cached: boolean;
  components: Record<string, ComponentHealth>;
}

/* ---------------------------------------------------------------------------
 * The rest of the internal surface.
 *
 * Every body under `/internal/*` that the API reads is declared here once. The
 * controller's store models and the API's client both import these
 * declarations; neither is allowed a structural copy, because the last copies
 * had already drifted (`scope` and `reason` widened to `string`, which silently
 * added label values to `sandbox_rate_limited_total`).
 * ------------------------------------------------------------------------- */

/** `/internal/payment-intents/claim`. A 200 or a 409: every branch is decided. */
export type IntentClaimResult =
  | { status: "claimed"; recovered: boolean; token: string; expiresAt: number }
  | { status: "settled"; sessionId: string }
  | { status: "in_progress" }
  | {
      status: "failed";
      /** Why the earlier attempt failed, or null when the row carries none. */
      reason: string | null;
    }
  | { status: "mismatch" };

/** `/internal/payment-intents/:paymentKey/complete`. */
export interface IntentCompletion {
  /**
   * The session the payment owns. Null only when a settled intent's row has no
   * session id; the API answers that as a 503 with the receipt, so the type
   * does not promise a string the controller cannot send.
   */
  sessionId: string | null;
  state: SessionState;
  created?: boolean;
  /**
   * The session view, folded in so the create path needs no second round trip.
   * Absent on older controllers, which keeps the API's `getSession` fallback.
   */
  session?: ControllerSessionView;
}

/** `/internal/challenge-nonces`: a single-use value for the 402 challenge (#47). */
export interface IssuedChallengeNonce {
  nonce: string;
  expiresAt: number;
}

/**
 * `/internal/challenge-nonces/:nonce/burn` (F-07).
 *
 * `replay` is the same payment retrying, which is the crash-recovery path, not
 * an error. `reused` is a different payment presenting a nonce it did not mint.
 */
export const CHALLENGE_BURN_STATUSES = [
  "burned",
  "replay",
  "expired",
  "unknown",
  "reused",
] as const;

export type ChallengeBurnStatus = (typeof CHALLENGE_BURN_STATUSES)[number];

export interface ChallengeBurnResult {
  status: ChallengeBurnStatus;
}

/**
 * `/internal/budgets/reserve` (#48): the durable create budget.
 *
 * `scope` is both the refusal vocabulary and the `scope` label of
 * `sandbox_budget_rejections_total`, so it is closed: a member nobody can
 * produce is not a label anyone should be able to emit. The list is global
 * before payer because that is the order the controller decides in.
 */
export const BUDGET_SCOPES = [
  "global_create",
  "global_concurrent",
  "payer_create",
  "payer_spend",
  "payer_concurrent",
] as const;

export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export interface BudgetRemaining {
  /** Creates left for this payer in the window; null when no payer was given. */
  payerCreates: number | null;
  /** Atomic units left to spend in the window. */
  payerSpend: string | null;
  /** Concurrent sessions this payer may still open; null = unlimited. */
  payerConcurrent: number | null;
  /** Creates left globally in the window. */
  globalCreates: number;
  /** Concurrent sessions cluster-wide; null = unlimited. */
  globalConcurrent: number | null;
}

export type BudgetDecision =
  | { ok: true; remaining: BudgetRemaining; windowResetsAt: number }
  | {
      ok: false;
      scope: BudgetScope;
      retryAfterSeconds: number;
      remaining: BudgetRemaining;
      windowResetsAt: number;
    };

/**
 * `/internal/payer-allowlist/authorize` (ADR 0013).
 *
 * A refusal names why, so the API can tell "not on the list" (the ordinary paid
 * path) from a lookup that cannot answer (fail closed). Each member is also a
 * `result` label of `sandbox_allowlist_decisions_total`.
 */
export const ALLOWLIST_REFUSAL_REASONS = [
  "not_allowlisted",
  "disabled",
  "tier_not_allowed",
  "concurrency_exhausted",
] as const;

export type AllowlistRefusalReason = (typeof ALLOWLIST_REFUSAL_REASONS)[number];

export type AllowlistDecision =
  | { allowed: true; label: string; maxTier: SessionTier; maxConcurrent: number }
  | { allowed: false; reason: AllowlistRefusalReason };

/**
 * `/internal/create-switch` (schema v21): the create kill switch.
 *
 * One row, not a process setting: an operator flips it without a rollout, it
 * survives a restart, and every API replica reads the same answer. `enabled` is
 * already the effective state, expiry included, and `expired` says the row
 * timed out rather than being disabled. An absent row is not an error: it reads
 * as disabled with `changedAt` and `expiresAt` null.
 */
export interface CreateSwitchState {
  /** True when new creates are refused. */
  enabled: boolean;
  /** Why the state was set. Empty when no row has ever been written. */
  reason: string;
  /** Who set it: a free-text actor string, never a credential. */
  actor: string;
  /** When it was set, epoch ms; null when no row has ever been written. */
  changedAt: number | null;
  /** When it turns itself off, epoch ms, or null for "until disabled". */
  expiresAt: number | null;
  /** The row expired rather than being disabled by an operator. */
  expired: boolean;
}

/** A quantity in the scheduler's units: millicores and bytes. */
export interface ResourceVector {
  cpuMillicores: number;
  memoryBytes: number;
  storageBytes: number;
}

/**
 * Why a placement was refused. Closed: it is the `reason` label of
 * `sandbox_admission_rejections_total`, and the API forwards it to the caller.
 */
export const ADMISSION_REJECTION_REASONS = [
  "invalid_request",
  "no_nodes",
  "no_eligible_nodes",
  "node_affinity_unavailable",
  "insufficient_cpu",
  "insufficient_memory",
  "insufficient_storage",
  "runtime_profile_unavailable",
] as const;

export type AdmissionRejectionReason = (typeof ADMISSION_REJECTION_REASONS)[number];

/**
 * `/internal/capacity/preflight` and `/internal/capacity/holds`.
 *
 * The placement plan and the cluster's free capacity stay in the controller:
 * the API acts on whether compute was admitted, on which node, and on whether a
 * refusal is worth retrying. `availableAfter` is preflight information and is
 * absent from a hold.
 */
export type CapacityDecision =
  | {
      admitted: true;
      nodeId: string;
      /** The reservation the fit was taken against; its node is `nodeId`. */
      reservation: { nodeId: string };
      availableAfter?: ResourceVector;
    }
  | {
      admitted: false;
      reason: AdmissionRejectionReason;
      retryable: boolean;
      requested: ResourceVector;
    };
