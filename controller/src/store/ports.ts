import type {
  ChallengeBurnResult,
  ClaimOperationResult,
  ClaimedRefund,
  ExecRequestRecord,
  IntentClaimResult,
  LedgerStatus,
  PaymentIntentRecord,
  PaymentLedgerRecord,
  PaymentRecord,
  RefundClaimRequest,
  SessionRecord,
  SessionState,
  StoreHealth,
} from "./models.js";
import type { ReservationStore } from "../capacity/reservation-store.js";
import type { BudgetDecision, BudgetLimits } from "./budget-decision.js";

/**
 * Narrow store surfaces, one per consumer.
 *
 * These are declared independently of the concrete `Store` adapter rather than
 * derived from it (`Pick<Store, ...>`). TypeScript's structural typing means
 * `Store` still satisfies every port, so the composition root can pass the
 * concrete class down without a cast, while each consumer depends only on the
 * interface it declared.
 *
 * The direction matters: a port may not depend on the adapter. Adding a method
 * to `StoreBackend` therefore cannot widen any consumer's dependency. Satisfying
 * these interfaces is necessary but not sufficient for a replacement adapter:
 * ADR 0010 also requires it to keep the guarded-transition and uniqueness
 * guarantees the original single-connection adapter got from serialising writes.
 *
 * **Every method returns a `Promise`.** `node:sqlite` was synchronous, so the
 * first adapter could return values directly; no network client can, so the
 * ports are `Promise`-returning and the synchronous adapter satisfied them with
 * `async` methods. The async shape is the contract, and it is what made the
 * Postgres adapter possible.
 *
 * A consequence callers must respect: a store call is an interleaving point. Two
 * calls that used to be adjacent now have a tick between them, so a read
 * followed by a write is not a transaction. Where the answer must be decided
 * atomically, the adapter owns it inside one statement or one transaction
 * (guarded `UPDATE ... WHERE state = ...`, a transaction-scoped advisory lock),
 * never the caller.
 *
 * Drift is caught for free: every port is exercised by a real call site that
 * passes a `StoreBackend` (the reconciler and the control API entrypoint), so a
 * signature mismatch fails `tsc`.
 */

/**
 * Guarded session writes and local field clears the effect interpreter
 * performs (`controller/src/effects.ts`).
 *
 * Separate from the use-case ports because every use case shares the
 * interpreter: a module that executes effects depends on this, plus only the
 * reads it needs. Each write is the same guarded UPDATE the reconciler used
 * before the table became the runtime, so a lost race still refuses.
 */
export interface EffectStore {
  clearPod(id: string): Promise<void>;
  clearWorkspacePvc(id: string): Promise<void>;
  finalizeTermination(id: string): Promise<SessionState | null>;
  markRelayPurged(id: string): Promise<void>;
  markSuspended(id: string, suspendedAt: number): Promise<boolean>;
  markSuspending(id: string): Promise<boolean>;
  setReady(
    id: string,
    readyAt: number,
    leaseExpiresAt: number,
    attestationJson: string,
    guestPublicKey: string,
  ): Promise<boolean>;
}

export interface ProvisioningStore {
  listNonTerminal(): Promise<SessionRecord[]>;
  /** Guarded write that names the resumed pod; false when the row moved on. */
  markResuming(id: string, podName: string): Promise<boolean>;
  mergeTimings(id: string, patch: Record<string, number | undefined>): Promise<void>;
  requestTermination(
    id: string,
    reason: string,
    failure?: { code: string; message: string },
  ): Promise<boolean>;
  setNodeName(id: string, nodeName: string): Promise<void>;
  setProvisioning(id: string, podName: string): Promise<boolean>;
  setProvisioningPod(id: string, podName: string): Promise<boolean>;
  setReady(
    id: string,
    readyAt: number,
    leaseExpiresAt: number,
    attestationJson: string,
    guestPublicKey: string,
  ): Promise<boolean>;
  setRelayToken(id: string, tokenHash: string): Promise<void>;
  setWorkspacePvc(id: string, pvcName: string): Promise<void>;
}

export interface WarmPoolStore {
  mergeTimings(id: string, patch: Record<string, number | undefined>): Promise<void>;
  setProvisioning(id: string, podName: string): Promise<boolean>;
  setRelayToken(id: string, tokenHash: string): Promise<void>;
}

export interface TerminationStore {
  clearPod(id: string): Promise<void>;
  clearWorkspacePvc(id: string): Promise<void>;
  finalizeTermination(id: string): Promise<SessionState | null>;
  getSession(id: string): Promise<SessionRecord | null>;
  markRelayPurged(id: string): Promise<void>;
  mergeTimings(id: string, patch: Record<string, number | undefined>): Promise<void>;
  requestTermination(
    id: string,
    reason: string,
    failure?: { code: string; message: string },
  ): Promise<boolean>;
  // RefundService shares this store.
  getLedgerBySession(sessionId: string): Promise<PaymentLedgerRecord | null>;
  listRelayLostSettled(): Promise<PaymentLedgerRecord[]>;
  listUnclaimedSettled(): Promise<PaymentLedgerRecord[]>;
  listUnrefundedTerminalBeforeReady(): Promise<PaymentLedgerRecord[]>;
  markRefundPending(paymentKey: string, reason: string): Promise<boolean>;
  markRefunded(paymentKey: string, transaction: string, reason: string): Promise<boolean>;
}

export interface LifecycleStore {
  clearPod(id: string): Promise<void>;
  clearWorkspacePvc(id: string): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  listNonTerminal(): Promise<SessionRecord[]>;
  listTerminalWithPvc(): Promise<SessionRecord[]>;
  markRelayPurged(id: string): Promise<void>;
  markSuspended(id: string, suspendedAt: number): Promise<boolean>;
  markSuspending(id: string): Promise<boolean>;
  requestTermination(
    id: string,
    reason: string,
    failure?: { code: string; message: string },
  ): Promise<boolean>;
  setNodeName(id: string, nodeName: string): Promise<void>;
}

export interface RefundStore {
  getLedgerBySession(sessionId: string): Promise<PaymentLedgerRecord | null>;
  getSession(id: string): Promise<SessionRecord | null>;
  /** Terminal relay-loss rows still settled: paid time that was lost (#31). */
  listRelayLostSettled(): Promise<PaymentLedgerRecord[]>;
  /** Settled rows with no session: unentitled or duplicate charges (#31). */
  listUnclaimedSettled(): Promise<PaymentLedgerRecord[]>;
  listUnrefundedTerminalBeforeReady(): Promise<PaymentLedgerRecord[]>;
  markRefundPending(paymentKey: string, reason: string): Promise<boolean>;
  markRefunded(paymentKey: string, transaction: string, reason: string): Promise<boolean>;
}

/** Automated refund execution (#31). */
export interface RefundWorkerStore {
  countLedgerByStatus(status: LedgerStatus): Promise<number>;
  /**
   * Durably claim due refunds before sending. Two callers never receive the
   * same row, and a row whose previous claim lease expired is reclaimed with a
   * fresh token (see `PgLedgerRepository.claimRefunds`).
   */
  claimRefunds(request: RefundClaimRequest): Promise<ClaimedRefund[]>;
  /** Provider paid: SENDING -> REFUNDED, only for the claim owner. */
  completeRefundClaim(paymentKey: string, claimToken: string, transaction: string): Promise<boolean>;
  /** Provider declined: SENDING -> PENDING with one failed attempt counted. */
  releaseRefundClaim(
    paymentKey: string,
    claimToken: string,
    error: string,
    nextAttemptAt: number,
  ): Promise<boolean>;
}

/** Settlement recovery for the settle-then-crash window (#31). */
export interface SettlementRecoveryStore {
  getLedgerByNonce(settlementNonce: string): Promise<PaymentLedgerRecord | null>;
  getLedgerByPayment(paymentKey: string): Promise<PaymentLedgerRecord | null>;
  insertUnclaimedLedger(entry: {
    paymentKey: string;
    sessionId: string;
    payer: string | null;
    amount: string;
    asset: string;
    network: string;
    mode: "mock" | "testnet";
    status: LedgerStatus;
    reason: string;
    refundTransaction?: string | null;
    settlementNonce: string | null;
  }): Promise<boolean>;
  listStaleClaimedIntents(olderThan: number, limit: number): Promise<PaymentIntentRecord[]>;
}

export interface SessionViewStore {
  getPayment(key: string): Promise<PaymentRecord | null>;
  getSession(id: string): Promise<SessionRecord | null>;
}

export interface CapacityStore {
  getSession(id: string): Promise<SessionRecord | null>;
  reservations: ReservationStore;
}

/** Everything the control API's payment and session routes touch. */
export interface ControlApiStore {
  claimOperation(
    sessionId: string,
    requestId: string,
    op: string,
    payloadHash?: string | null,
  ): Promise<ClaimOperationResult>;
  claimPaymentIntent(
    paymentKey: string,
    specHashValue: string,
    staleMs: number,
    requirementsJson?: string | null,
  ): Promise<IntentClaimResult>;
  /** Single-use challenge nonce (#47): mint, burn, and never resurrect. */
  issueChallengeNonce(
    nonce: string,
    ttlMs: number,
    maxActive: number,
  ): Promise<{ nonce: string; expiresAt: number }>;
  burnChallengeNonce(nonce: string, paymentKey: string): Promise<ChallengeBurnResult>;
  /** Durable per-payer and global create budget (#48). */
  reserveBudgets(
    payer: string | null,
    amountAtomic: string,
    limits: BudgetLimits,
  ): Promise<BudgetDecision>;
  completeEntitlement(
    paymentKey: string,
    claimToken: string,
    payment: PaymentRecord,
    session: SessionRecord,
  ): Promise<{ sessionId: string; created: boolean }>;
  failPaymentIntent(paymentKey: string, reason: string): Promise<void>;
  finishOperation(
    sessionId: string,
    requestId: string,
    outcome: "done" | "error" | "abandoned",
    /** The sealed result to keep with the row; omitted or over the bound, none is stored. */
    resultEnvelope?: string | null,
  ): Promise<void>;
  getExecRequest(sessionId: string, requestId: string): Promise<ExecRequestRecord | null>;
  getLedgerByNonce(settlementNonce: string): Promise<PaymentLedgerRecord | null>;
  getLedgerByPayment(paymentKey: string): Promise<PaymentLedgerRecord | null>;
  getPayment(key: string): Promise<PaymentRecord | null>;
  getPaymentIntent(paymentKey: string): Promise<PaymentIntentRecord | null>;
  getSession(id: string): Promise<SessionRecord | null>;
  healthCheck(): Promise<StoreHealth>;
  listLedgerByStatus(status: LedgerStatus): Promise<PaymentLedgerRecord[]>;
  markRefunded(paymentKey: string, transaction: string, reason: string): Promise<boolean>;
  mergeTimings(id: string, patch: Record<string, number | undefined>): Promise<void>;
  requestDestroy(id: string): Promise<void>;
  requestTermination(
    id: string,
    reason: string,
    failure?: { code: string; message: string },
  ): Promise<boolean>;
  touchActivity(id: string): Promise<void>;
}

/** Restart-recovery fence: the operations the fence needs and nothing else. */
export interface FenceStore {
  clearFencedGate(sessionId: string, requestId: string, epoch: number): Promise<boolean>;
  listFencedSessions(): Promise<SessionRecord[]>;
}

/** The reconcile scheduler's own view: due selection plus the cleanup sweep. */
interface SchedulerStore {
  clearPod(id: string): Promise<void>;
  countDue(nowMs: number): Promise<number>;
  countLiveByState(): Promise<Partial<Record<SessionState, number>>>;
  getSession(id: string): Promise<SessionRecord | null>;
  listDue(nowMs: number, limit: number): Promise<SessionRecord[]>;
  listTerminalWithPod(): Promise<SessionRecord[]>;
  /** Drop expired single-use challenge nonces (#47). */
  pruneChallengeNonces(): Promise<number>;
  rearmDue(id: string, atMs: number, nowMs: number): Promise<boolean>;
}

/**
 * What the reconciler context holds, and what it hands to its sub-services.
 * Composed from the narrow ports above, so it cannot drift wider than the
 * reconciler's actual use and every member is owned by exactly one consumer.
 */
export type ReconcilerStore = ProvisioningStore &
  LifecycleStore &
  TerminationStore &
  WarmPoolStore &
  CapacityStore &
  FenceStore &
  SchedulerStore &
  RefundWorkerStore &
  SettlementRecoveryStore;
