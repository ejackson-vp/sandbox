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
  mapIntent,
  PaymentAlreadyRedeemedError,
  PaymentClaimLostError,
  type IntentClaimResult,
  type PaymentIntentRecord,
  type PaymentRecord,
  type SessionRecord,
} from "./models.js";

export class PaymentRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly stmts: Record<string, StatementSync>,
  ) {}

  /**
   * Lease an intent to this caller. The returned token is the ownership fence:
   * only the holder of the current token may complete. A claim older than its
   * recorded lease, or older than the caller's `staleMs`, is a crash path and
   * can be reclaimed; the previous owner then loses the token.
   */
  claimPaymentIntent(paymentKey: string, specHashValue: string, staleMs: number): IntentClaimResult {
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
      this.stmts.insertIntent!.run(paymentKey, specHashValue, token, expiresAt, now, now);
      this.db.exec("COMMIT");
      return { status: "claimed", recovered: false, token, expiresAt };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
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
      this.db.exec("COMMIT");
      return { sessionId: session.id, created: true };
    } catch (err) {
      this.db.exec("ROLLBACK");
      const msg = (err as Error).message;
      if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
        throw new PaymentAlreadyRedeemedError(paymentKey);
      }
      throw err;
    }
  }
}
