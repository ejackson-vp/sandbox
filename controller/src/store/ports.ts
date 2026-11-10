import type {
  ClaimOperationResult,
  ExecRequestRecord,
  IntentClaimResult,
  LedgerStatus,
  PaymentIntentRecord,
  PaymentLedgerRecord,
  PaymentRecord,
  SessionRecord,
  SessionState,
} from "./models.js";
import type { ReservationStore } from "../capacity/reservation-store.js";
import type { StoreHealth } from "./health.js";

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
 * to `Store` therefore cannot widen any consumer's dependency, and replacing the
 * SQLite adapter with Postgres only has to satisfy these interfaces.
 *
 * Drift is caught for free: every port is exercised by a real call site that
 * passes a `Store` (the reconciler, the control API entrypoint and the metrics
 * collector), so a signature mismatch fails `tsc`.
 */

export interface ProvisioningStore {
  listNonTerminal(): SessionRecord[];
  mergeTimings(id: string, patch: Record<string, number | undefined>): void;
  requestTermination(
    id: string,
    reason: string,
    failure?: { code: string; message: string },
  ): boolean;
  setNodeName(id: string, nodeName: string): void;
  setProvisioning(id: string, podName: string): boolean;
  setProvisioningPod(id: string, podName: string): boolean;
  setReady(
    id: string,
    readyAt: number,
    leaseExpiresAt: number,
    attestationJson: string,
    guestPublicKey: string,
  ): boolean;
  setRelayToken(id: string, tokenHash: string): void;
  setWorkspacePvc(id: string, pvcName: string): void;
}

export interface WarmPoolStore {
  mergeTimings(id: string, patch: Record<string, number | undefined>): void;
  setProvisioning(id: string, podName: string): boolean;
  setRelayToken(id: string, tokenHash: string): void;
}

export interface TerminationStore {
  clearPod(id: string): void;
  clearWorkspacePvc(id: string): void;
  finalizeTermination(id: string): SessionState | null;
  getSession(id: string): SessionRecord | null;
  markRelayPurged(id: string): void;
  mergeTimings(id: string, patch: Record<string, number | undefined>): void;
  requestTermination(
    id: string,
    reason: string,
    failure?: { code: string; message: string },
  ): boolean;
  // RefundService shares this store.
  getLedgerBySession(sessionId: string): PaymentLedgerRecord | null;
  listUnrefundedTerminalBeforeReady(): PaymentLedgerRecord[];
  markRefundPending(paymentKey: string, reason: string): boolean;
  markRefunded(paymentKey: string, transaction: string, reason: string): boolean;
}

export interface LifecycleStore {
  clearPod(id: string): void;
  clearWorkspacePvc(id: string): void;
  getSession(id: string): SessionRecord | null;
  listNonTerminal(): SessionRecord[];
  listTerminalWithPvc(): SessionRecord[];
  markResuming(id: string, podName: string): boolean;
  markSuspended(id: string, suspendedAt: number): boolean;
  markSuspending(id: string): boolean;
  requestTermination(
    id: string,
    reason: string,
    failure?: { code: string; message: string },
  ): boolean;
  setNodeName(id: string, nodeName: string): void;
}

export interface RefundStore {
  getLedgerBySession(sessionId: string): PaymentLedgerRecord | null;
  getSession(id: string): SessionRecord | null;
  listUnrefundedTerminalBeforeReady(): PaymentLedgerRecord[];
  markRefundPending(paymentKey: string, reason: string): boolean;
  markRefunded(paymentKey: string, transaction: string, reason: string): boolean;
}

export interface SessionViewStore {
  getPayment(key: string): PaymentRecord | null;
  getSession(id: string): SessionRecord | null;
}

export interface CapacityStore {
  getSession(id: string): SessionRecord | null;
  reservations: ReservationStore;
}

/** Everything the control API's payment and session routes touch. */
export interface ControlApiStore {
  claimOperation(sessionId: string, requestId: string, op: string): ClaimOperationResult;
  claimPaymentIntent(
    paymentKey: string,
    specHashValue: string,
    staleMs: number,
  ): IntentClaimResult;
  completeEntitlement(
    paymentKey: string,
    claimToken: string,
    payment: PaymentRecord,
    session: SessionRecord,
  ): { sessionId: string; created: boolean };
  failPaymentIntent(paymentKey: string, reason: string): void;
  finishOperation(
    sessionId: string,
    requestId: string,
    outcome: "done" | "error" | "abandoned",
  ): void;
  getExecRequest(sessionId: string, requestId: string): ExecRequestRecord | null;
  getLedgerByPayment(paymentKey: string): PaymentLedgerRecord | null;
  getPayment(key: string): PaymentRecord | null;
  getPaymentIntent(paymentKey: string): PaymentIntentRecord | null;
  getSession(id: string): SessionRecord | null;
  healthCheck(): StoreHealth;
  listLedgerByStatus(status: LedgerStatus): PaymentLedgerRecord[];
  markRefunded(paymentKey: string, transaction: string, reason: string): boolean;
  mergeTimings(id: string, patch: Record<string, number | undefined>): void;
  requestDestroy(id: string): void;
  requestTermination(
    id: string,
    reason: string,
    failure?: { code: string; message: string },
  ): boolean;
  touchActivity(id: string): void;
}

/** Restart-recovery fence: the operations the fence needs and nothing else. */
export interface FenceStore {
  clearFencedGate(sessionId: string, requestId: string, epoch: number): boolean;
  listFencedSessions(): SessionRecord[];
}

/** Scrape-time SQLite collector. */
export interface MetricsStore {
  stats(): { sizeBytes: number; walBytes: number };
}

/** The reconcile scheduler's own view: due selection plus the cleanup sweep. */
export interface SchedulerStore {
  backupTo(path: string): Promise<void>;
  clearPod(id: string): void;
  countDue(nowMs: number): number;
  countLiveByState(): Partial<Record<SessionState, number>>;
  getSession(id: string): SessionRecord | null;
  listDue(nowMs: number, limit: number): SessionRecord[];
  listTerminalWithPod(): SessionRecord[];
  rearmDue(id: string, atMs: number, nowMs: number): boolean;
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
  SchedulerStore;
