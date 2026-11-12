/**
 * Payment ledger refund policy.
 *
 * A settled session that never reached READY delivered no service, so its
 * payment is refundable. Mock payments are refunded immediately with a mock
 * transaction id; real payment modes are left REFUND_PENDING for the refund
 * worker (`refund-worker.ts`) or an operator. The ledger transition is
 * conditional, so repeated termination/finalize paths cannot refund twice.
 *
 * One exception to "READY means no refund": a session the relay-continuity
 * branch terminates as `failure:relay_lost` did reach READY, but the paid time
 * after the loss was undeliverable, so it is refunded in full. A client destroy
 * and an ordinary lease expiry after READY stay settled.
 *
 * The same policy applies to a payment that never got a session at all
 * (settlement recovery) and to a duplicate charge, which is why it is a public
 * method rather than three copies of an if-statement.
 */
import { log, metrics } from "@x402s/shared/runtime";
import type { PaymentLedgerRecord, SessionRecord, SessionState } from "./store/models.js";
import type { RefundStore } from "./store/ports.js";

export type RefundOutcome = "refunded" | "pending" | "not_applicable";

/** The one termination reason that refunds a session which had reached READY. */
const RELAY_LOST_REASON = "relay_lost";
const RELAY_LOST_TERMINATION = `failure:${RELAY_LOST_REASON}`;

/**
 * True when the relay continuity branch ended this session because it could not
 * be resumed. A client destroy or an ordinary lease expiry is not this.
 */
function interruptedByRelayLoss(session: SessionRecord): boolean {
  const reason = session.terminationReason ?? "";
  return (
    reason === RELAY_LOST_TERMINATION ||
    reason === RELAY_LOST_REASON ||
    session.failureCode === RELAY_LOST_REASON
  );
}

export class RefundService {
  constructor(private readonly store: RefundStore) {}

  /** Repair a crash between finalisation and the refund write. */
  async reconcile(): Promise<void> {
    for (const ledger of await this.store.listUnrefundedTerminalBeforeReady()) {
      const session = await this.store.getSession(ledger.sessionId);
      if (session) await this.refund(session, session.state);
    }
    // Ready sessions interrupted by relay loss: the ordinary before-READY query
    // cannot see them, and the termination path may have crashed before it
    // applied the policy.
    for (const ledger of await this.store.listRelayLostSettled()) {
      const session = await this.store.getSession(ledger.sessionId);
      if (session) await this.refund(session, session.state);
    }
    // Payments with no session at all: settlement recovery or a duplicate
    // charge that was interrupted between the ledger write and the policy.
    for (const ledger of await this.store.listUnclaimedSettled()) {
      await this.applyPolicy(ledger, ledger.reason ?? "settled_without_entitlement");
    }
  }

  async refund(session: SessionRecord, finalState: SessionState): Promise<RefundOutcome> {
    if (finalState !== "FAILED" && finalState !== "EXPIRED" && finalState !== "DESTROYED") {
      return "not_applicable";
    }
    const relayLost = interruptedByRelayLoss(session);
    // Service was delivered, so the default is no refund. Relay loss is the
    // deliberate exception: the session was cut short through no client action.
    if (session.readyAt !== null && !relayLost) return "not_applicable";

    const ledger = await this.store.getLedgerBySession(session.id);
    if (!ledger || ledger.status !== "SETTLED") return "not_applicable";

    const reason = relayLost
      ? `service_interrupted:${RELAY_LOST_REASON}`
      : `no_service_delivered:${session.terminationReason ?? finalState}`.slice(0, 500);
    return this.applyPolicy(ledger, reason);
  }

  /**
   * Apply the refund policy to one ledger row that is already `SETTLED`.
   *
   * Mock: refund now with a mock transaction id. Every real mode: mark
   * `REFUND_PENDING` and leave the transfer to the worker or an operator. Returns
   * `not_applicable` when the row moved on (already refunded, already pending),
   * which is what makes this safe to call from more than one path.
   */
  async applyPolicy(ledger: PaymentLedgerRecord, reason: string): Promise<RefundOutcome> {
    const bounded = reason.slice(0, 500);
    if (ledger.status !== "SETTLED") return "not_applicable";

    if (ledger.mode === "mock") {
      const transaction = `mock:refund:${ledger.paymentKey.slice(0, 12)}:${Date.now().toString(36)}`;
      const changed = await this.store.markRefunded(ledger.paymentKey, transaction, bounded);
      if (!changed) return "not_applicable";
      metrics.counter("sandbox_refunds_total", "Payment refund outcomes").inc({ mode: "mock", result: "refunded" });
      log.info("payment_refunded", {
        sessionId: ledger.sessionId,
        paymentKeyPrefix: ledger.paymentKey.slice(0, 12),
        amount: ledger.amount,
        transaction,
      });
      return "refunded";
    }

    const changed = await this.store.markRefundPending(ledger.paymentKey, bounded);
    if (!changed) return "not_applicable";
    metrics.counter("sandbox_refunds_total", "Payment refund outcomes").inc({ mode: ledger.mode, result: "pending" });
    log.warn("payment_refund_pending", {
      sessionId: ledger.sessionId,
      paymentKeyPrefix: ledger.paymentKey.slice(0, 12),
      amount: ledger.amount,
      reason: bounded,
    });
    return "pending";
  }
}
