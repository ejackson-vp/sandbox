/**
 * Payment intents, settlement and the outbox half of the store.
 *
 * Extracted from `Store` so the facade stays reviewable. The transaction
 * boundaries and single-writer assumptions are unchanged: this repository runs
 * on the same connection and prepared statements as the rest of the store.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  DuplicateEntitlementError,
  mapIntent,
  PaymentAlreadyRedeemedError,
  PaymentClaimLostError,
  type IntentClaimResult,
  type PaymentIntentRecord,
  type PaymentRecord,
  type SessionRecord,
} from "./models.js";
import { DEFAULT_RUNTIME } from "@x402s/shared/runtimes";
import type { BudgetRepository } from "./budgets.js";

export class PaymentRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly stmts: Record<string, StatementSync>,
    private readonly budgets: BudgetRepository,
    private readonly budgetWindowMs: number,
  ) {}

  /**
   * Lease an intent to this caller. The returned token is the ownership fence:
   * only the holder of the current token may complete. A claim older than its
   * recorded lease, or older than the caller's `staleMs`, is a crash path and
   * can be reclaimed; the previous owner then loses the token.
   */
  claimPaymentIntent(
    paymentKey: string,
    specHashValue: string,
    staleMs: number,
    requirementsJson: string | null = null,
  ): IntentClaimResult {
    const now = Date.now();
    const token = randomBytes(16).toString("hex");
    const expiresAt = now + staleMs;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const raw = this.stmts.getIntent!.get(paymentKey) as Record<string, unknown> | undefined;
      if (raw) {
        const intent = mapIntent(raw);
        if (intent.specHash !== specHashValue) {
          this.db.exec("COMMIT");
          return { status: "mismatch" };
        }
        if (intent.status === "settled" && intent.sessionId) {
          this.db.exec("COMMIT");
          return { status: "settled", sessionId: intent.sessionId };
        }
        if (intent.status === "failed") {
          this.db.exec("COMMIT");
          return { status: "failed", reason: intent.reason };
        }
        // claimed: either in flight or stale after a crash. The recorded lease
        // is authoritative; the age check keeps the original `staleMs` recovery
        // path (and pre-v10 rows, which have no lease) working.
        const leaseExpired = intent.claimExpiresAt !== null && now >= intent.claimExpiresAt;
        const agedOut = now - intent.updatedAt >= staleMs;
        if (!leaseExpired && !agedOut) {
          this.db.exec("COMMIT");
          return { status: "in_progress" };
        }
        const reclaimed = this.stmts.reclaimIntent!.run(token, expiresAt, now, paymentKey);
        this.db.exec("COMMIT");
        if (reclaimed.changes === 0) return { status: "in_progress" };
        return { status: "claimed", recovered: true, token, expiresAt };
      }
      this.stmts.insertIntent!.run(
        paymentKey,
        specHashValue,
        token,
        expiresAt,
        requirementsJson,
        now,
        now,
      );
      this.db.exec("COMMIT");
      return { status: "claimed", recovered: false, token, expiresAt };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** The settled payment row, as the API views it. */
  getPaymentRecord(paymentKey: string): PaymentRecord | null {
    const row = this.stmts.getPayment!.get(paymentKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      paymentKey: row.payment_key as string,
      network: row.network as string,
      scheme: row.scheme as string,
      asset: row.asset as string,
      amount: row.amount as string,
      payTo: row.pay_to as string,
      payer: row.payer as string | undefined,
      transaction: row.tx as string | undefined,
      mode: row.mode as "mock" | "testnet",
    };
  }

  getPaymentIntent(paymentKey: string): PaymentIntentRecord | null {
    const raw = this.stmts.getIntent!.get(paymentKey) as Record<string, unknown> | undefined;
    return raw ? mapIntent(raw) : null;
  }

  failPaymentIntent(paymentKey: string, reason: string): void {
    this.stmts.failIntent!.run(reason.slice(0, 500), Date.now(), paymentKey);
  }

  /**
   * Atomically: record the payment, create the session, and mark the intent
   * settled. The caller must present the claim token it was given by
   * `claimPaymentIntent`; a stale owner is rejected.
   *
   * Idempotent: if another worker already settled the intent, this returns that
   * session with `created: false` instead of throwing. A crash before this
   * leaves the intent `claimed`, which the API resolves by asking the
   * facilitator whether settlement happened.
   */
  completeEntitlement(
    paymentKey: string,
    claimToken: string,
    payment: PaymentRecord,
    session: SessionRecord,
  ): { sessionId: string; created: boolean } {
    let duplicateOf: string | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const raw = this.stmts.getIntent!.get(paymentKey) as Record<string, unknown> | undefined;
      if (!raw) throw new PaymentClaimLostError(paymentKey);
      const intent = mapIntent(raw);
      // Already settled: the winner's session is the answer, not an error.
      if (intent.status === "settled" && intent.sessionId) {
        this.db.exec("COMMIT");
        return { sessionId: intent.sessionId, created: false };
      }
      if (intent.status !== "claimed" || intent.claimToken !== claimToken) {
        throw new PaymentClaimLostError(paymentKey);
      }

      // Double charge (#31): the same client key pair already owns a session, so
      // this is a second payment for the same logical client. Record the charge,
      // refund it, and refuse the second session. A well-behaved client
      // generates a fresh key pair per create, so this cannot fire by accident;
      // a retry of the *same* payment never reaches here (the intent is settled).
      const duplicate = this.stmts.findSessionByClientNonce!.get(
        session.clientPublicKey,
        session.clientNonce,
      ) as { id: string } | undefined;
      if (duplicate) {
        const now = Date.now();
        this.stmts.insertPayment!.run(
          payment.paymentKey,
          payment.network,
          payment.scheme,
          payment.asset,
          payment.amount,
          payment.payTo,
          payment.payer ?? null,
          payment.transaction ?? null,
          payment.mode,
          now,
        );
        const reason = "duplicate_client_nonce";
        // Mock payments are refunded automatically, exactly like the
        // terminal-before-READY policy; a real mode waits for the refund worker.
        const refunded = payment.mode === "mock";
        this.stmts.insertLedgerUnclaimed!.run(
          payment.paymentKey,
          `duplicate:${payment.paymentKey}`,
          payment.payer ?? null,
          payment.amount,
          payment.asset,
          payment.network,
          payment.mode,
          refunded ? "REFUNDED" : "REFUND_PENDING",
          reason,
          refunded ? `mock:refund:${payment.paymentKey.slice(0, 12)}:${now.toString(36)}` : null,
          payment.settlementNonce ?? null,
          now,
          now,
        );
        this.stmts.failIntent!.run(reason, now, paymentKey);
        this.db.exec("COMMIT");
        duplicateOf = duplicate.id;
      } else {
        this.stmts.insertPayment!.run(
          payment.paymentKey,
          payment.network,
          payment.scheme,
          payment.asset,
          payment.amount,
          payment.payTo,
          payment.payer ?? null,
          payment.transaction ?? null,
          payment.mode,
          Date.now(),
        );
        this.stmts.insertLedger!.run(
          payment.paymentKey,
          session.id,
          payment.payer ?? null,
          payment.amount,
          payment.asset,
          payment.network,
          payment.mode,
          payment.settlementNonce ?? null,
          Date.now(),
          Date.now(),
        );
        this.stmts.insertSession!.run(
          session.id,
          session.capabilityHash,
          session.capabilityExpiresAt,
          session.clientPublicKey,
          session.clientNonce,
          session.clientSigner ?? null,
          session.tier,
          session.durationSeconds,
          session.limits.cpuMillis,
          session.limits.memoryMiB,
          session.limits.diskMiB,
          session.limits.maxOutputBytes,
          session.limits.maxFileBytes,
          session.limits.maxCommandSeconds,
          session.limits.maxProcesses,
          session.state,
          session.createdAt,
          session.paidAt,
          session.paymentKey,
          session.runtimeClass,
          session.executionMode,
          session.runtime ?? DEFAULT_RUNTIME,
          session.relayTokenHash,
          session.updatedAt,
        );
        this.stmts.initLifecycle!.run(
          session.idlePolicyJson ?? null,
          session.maxLifetimeSeconds ?? null,
          session.lastActivityAt ?? session.createdAt,
          session.workspacePvc ?? null,
          session.suspendedAt ?? null,
          session.resumeCount ?? 0,
          session.baselineCpuMillis ?? null,
          session.baselineMemoryMib ?? null,
          session.updatedAt,
          session.id,
        );
        // Conditional on the token: a concurrent reclaim inside this transaction
        // has already changed it, so the stale owner cannot settle.
        const settled = this.stmts.settleIntent!.run(session.id, Date.now(), paymentKey, claimToken);
        if (settled.changes === 0) throw new PaymentClaimLostError(paymentKey);
        // Spend is committed with the ledger row, to the *verified* payer, in this
        // same transaction. A crash cannot leave a charge that the budget does not
        // know about, and a failed settlement never accrues spend (#48).
        this.budgets.recordSpendWithinTransaction(
          payment.payer ?? "",
          payment.amount,
          Date.now(),
          this.budgetWindowMs,
        );
        this.db.exec("COMMIT");
      }
    } catch (err) {
      this.db.exec("ROLLBACK");
      const msg = (err as Error).message;
      if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
        throw new PaymentAlreadyRedeemedError(paymentKey);
      }
      throw err;
    }
    // Committed above: the charge exists and is already marked for refund, so
    // the caller must be told about the session rather than retry.
    if (duplicateOf) throw new DuplicateEntitlementError(paymentKey, duplicateOf);
    return { sessionId: session.id, created: true };
  }
}
