/**
 * Payment ledger repository: the refund and reconciliation surface.
 *
 * Extracted from the `Store` facade so the facade stays reviewable. Transaction
 * boundaries are unchanged: every statement here runs on the same single-writer
 * connection, and the ones that matter (`markRefunded`, `markRefundPending`,
 * `markRefundAttempt`) are conditional on the current status, so two callers
 * cannot both win.
 */
import type { StatementSync } from "node:sqlite";
import {
  mapIntent,
  mapLedger,
  type LedgerStatus,
  type PaymentIntentRecord,
  type PaymentLedgerRecord,
} from "./models.js";

export interface UnclaimedLedgerEntry {
  paymentKey: string;
  sessionId: string;
  payer: string | null;
  amount: string;
  asset: string;
  network: string;
  mode: "mock" | "testnet";
  status: LedgerStatus;
  reason: string;
  settlementNonce: string | null;
}

export class LedgerRepository {
  constructor(private readonly stmts: Record<string, StatementSync>) {}

  getByPayment(paymentKey: string): PaymentLedgerRecord | null {
    const row = this.stmts.getLedgerByPayment!.get(paymentKey) as Record<string, unknown> | undefined;
    return row ? mapLedger(row) : null;
  }

  getBySession(sessionId: string): PaymentLedgerRecord | null {
    const row = this.stmts.getLedgerBySession!.get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapLedger(row) : null;
  }

  /** By EIP-3009 authorisation nonce, for a facilitator webhook or an operator. */
  getByNonce(settlementNonce: string): PaymentLedgerRecord | null {
    const row = this.stmts.getLedgerByNonce!.get(settlementNonce) as Record<string, unknown> | undefined;
    return row ? mapLedger(row) : null;
  }

  listByStatus(status: LedgerStatus): PaymentLedgerRecord[] {
    return (this.stmts.listLedgerByStatus!.all(status) as unknown as Array<Record<string, unknown>>).map(mapLedger);
  }

  countByStatus(status: LedgerStatus): number {
    return ((this.stmts.countLedgerByStatus!.get(status) as { n: number } | undefined)?.n ?? 0);
  }

  listUnrefundedTerminalBeforeReady(): PaymentLedgerRecord[] {
    return (
      this.stmts.listUnrefundedTerminalBeforeReady!.all() as unknown as Array<Record<string, unknown>>
    ).map(mapLedger);
  }

  /** Settled rows with no session: unentitled or duplicate charges. */
  listUnclaimedSettled(): PaymentLedgerRecord[] {
    return (this.stmts.listUnclaimedSettled!.all() as unknown as Array<Record<string, unknown>>).map(mapLedger);
  }

  /** REFUND_PENDING rows whose next attempt is due. */
  listRefundPendingDue(now: number, limit: number): PaymentLedgerRecord[] {
    return (
      this.stmts.listRefundPendingDue!.all(now, limit) as unknown as Array<Record<string, unknown>>
    ).map(mapLedger);
  }

  /**
   * Claimed intents past the recovery grace: the settle-then-crash window
   * (#31). Intent-shaped, but only the ledger consumers ask for it.
   */
  listStaleClaimedIntents(olderThan: number, limit: number): PaymentIntentRecord[] {
    return (
      this.stmts.listStaleClaimedIntents!.all(olderThan, limit) as unknown as Array<
        Record<string, unknown>
      >
    ).map(mapIntent);
  }

  markRefundPending(paymentKey: string, reason: string): boolean {
    return this.stmts.markRefundPending!.run(reason.slice(0, 500), Date.now(), paymentKey).changes > 0;
  }

  markRefunded(paymentKey: string, transaction: string, reason: string): boolean {
    return (
      this.stmts.markRefunded!.run(reason.slice(0, 500), transaction, Date.now(), paymentKey).changes > 0
    );
  }

  /** Record one failed refund attempt and back off. */
  recordRefundAttempt(paymentKey: string, error: string, nextAttemptAt: number): boolean {
    return (
      this.stmts.markRefundAttempt!.run(error.slice(0, 500), nextAttemptAt, Date.now(), paymentKey).changes > 0
    );
  }

  /**
   * Write the ledger row for a settled payment that no session consumed.
   * `INSERT OR IGNORE`: a concurrent reconciler or a manual refund wins.
   */
  insertUnclaimed(entry: UnclaimedLedgerEntry): boolean {
    const now = Date.now();
    return (
      this.stmts.insertLedgerUnclaimed!.run(
        entry.paymentKey,
        entry.sessionId,
        entry.payer,
        entry.amount,
        entry.asset,
        entry.network,
        entry.mode,
        entry.status,
        entry.reason,
        entry.settlementNonce,
        now,
        now,
      ).changes > 0
    );
  }
}
