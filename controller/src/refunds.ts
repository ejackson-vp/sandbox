/**
 * Payment ledger refund policy.
 *
 * A settled session that never reached READY delivered no service, so its
 * payment is refundable. Mock payments are refunded immediately with a mock
 * transaction id; real payment modes are left REFUND_PENDING for an operator or
 * a later on-chain/facilitator refund worker. The ledger transition is
 * conditional, so repeated termination/finalize paths cannot refund twice.
 */
import { metrics } from "@x402s/shared";
import { log } from "@x402s/shared";
import type { SessionRecord, SessionState } from "./store/models.js";
import type { RefundStore } from "./store/ports.js";

export type RefundOutcome = "refunded" | "pending" | "not_applicable";

export class RefundService {
  constructor(private readonly store: RefundStore) {}

  /** Repair a crash between finalisation and the refund write. */
  reconcile(): void {
    for (const ledger of this.store.listUnrefundedTerminalBeforeReady()) {
      const session = this.store.getSession(ledger.sessionId);
      if (session) this.refund(session, session.state);
    }
  }

  refund(session: SessionRecord, finalState: SessionState): RefundOutcome {
    if (session.readyAt !== null) return "not_applicable";
    if (finalState !== "FAILED" && finalState !== "EXPIRED" && finalState !== "DESTROYED") {
      return "not_applicable";
    }
    const ledger = this.store.getLedgerBySession(session.id);
    if (!ledger || ledger.status !== "SETTLED") return "not_applicable";

    const reason = `no_service_delivered:${session.terminationReason ?? finalState}`.slice(0, 500);
    if (ledger.mode === "mock") {
      const transaction = `mock:refund:${ledger.paymentKey.slice(0, 12)}:${Date.now().toString(36)}`;
      const changed = this.store.markRefunded(ledger.paymentKey, transaction, reason);
      if (!changed) return "not_applicable";
      metrics.counter("sandbox_refunds_total", "Payment refund outcomes").inc({ mode: "mock", result: "refunded" });
      log.info("payment_refunded", {
        sessionId: session.id,
        paymentKeyPrefix: ledger.paymentKey.slice(0, 12),
        amount: ledger.amount,
        transaction,
      });
      return "refunded";
    }

    const changed = this.store.markRefundPending(ledger.paymentKey, reason);
    if (!changed) return "not_applicable";
    metrics.counter("sandbox_refunds_total", "Payment refund outcomes").inc({ mode: ledger.mode, result: "pending" });
    log.warn("payment_refund_pending", {
      sessionId: session.id,
      paymentKeyPrefix: ledger.paymentKey.slice(0, 12),
      amount: ledger.amount,
      reason,
    });
    return "pending";
  }
}
