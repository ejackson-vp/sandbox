/**
 * Payment intents, settlement and the outbox half of the Postgres store.
 *
 * The claim fence is the same token it always was; what matters is how the fence
 * is enforced. The previous single-connection adapter ran the whole
 * `claimPaymentIntent` / `completeEntitlement` body inside one serialised
 * transaction, so the read → check → write sequence could not interleave. Here
 * the intent row is taken with `SELECT … FOR UPDATE` and the settle is a
 * conditional `UPDATE … WHERE status = 'claimed' AND claim_token = $n
 * RETURNING session_id`, so a second worker blocks on the row, re-reads the
 * committed state under `READ COMMITTED`, and returns the winner's session
 * instead of creating a second one.
 */
import { randomBytes } from "node:crypto";
import type { PaymentMode } from "@x402s/shared/protocol";
import { DEFAULT_RUNTIME } from "@x402s/shared/runtimes";
import {
  asClaimToken,
  claimLease,
  deadlinePassed,
  isHeldBy,
  leaseExpiresAt,
} from "@x402s/shared/durable";
import {
  DuplicateEntitlementError,
  LedgerSettledError,
  mapIntent,
  PaymentAlreadyRedeemedError,
  PaymentClaimLostError,
  type IntentClaimResult,
  type LedgerStatus,
  type PaymentIntentRecord,
  type PaymentRecord,
  type SessionRecord,
} from "../models.js";
import { advisoryKey, type PgConnection, type Querier, type Tx } from "./pg.js";
import type { PgBudgetRepository } from "./budgets.js";
import type { PgSessionRepository } from "./sessions.js";

/** A unique violation, the one server error the settlement path maps. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23505";
}

interface SettleOutcome {
  sessionId: string;
  created: boolean;
  duplicateOf?: string;
}

export class PgPaymentRepository {
  constructor(
    private readonly conn: PgConnection,
    private readonly sessions: PgSessionRepository,
    private readonly budgets: PgBudgetRepository,
    private readonly budgetWindowMs: number,
  ) {}

  private async readIntent(q: Querier, paymentKey: string): Promise<PaymentIntentRecord | null> {
    const res = await q.query("SELECT * FROM payment_intents WHERE payment_key = $1", [paymentKey]);
    const row = res.rows[0];
    return row ? mapIntent(row) : null;
  }

  /**
   * Lease an intent to this caller.
   *
   * Two statements, in this order: an `INSERT … ON CONFLICT DO NOTHING` decides
   * who created the row, and a conditional reclaim decides who takes over a
   * stale one. A claimer that loses either race re-reads and answers with the
   * committed state, using the same vocabulary as before
   * (`settled`, `failed`, `in_progress`, `mismatch`).
   */
  async claimPaymentIntent(
    paymentKey: string,
    specHashValue: string,
    staleMs: number,
    requirementsJson: string | null = null,
  ): Promise<IntentClaimResult> {
    const now = Date.now();
    const lease = claimLease(asClaimToken(randomBytes(16).toString("hex")), now, staleMs);
    const token = lease.token;
    const expiresAt = leaseExpiresAt(lease);
    const ageCutoff = now - staleMs;

    return this.conn.tx(async (tx) => {
      const existing = await this.readIntent(tx, paymentKey);
      if (existing) {
        if (existing.specHash !== specHashValue) return { status: "mismatch" };
        if (existing.status === "settled" && existing.sessionId) {
          return { status: "settled", sessionId: existing.sessionId };
        }
        if (existing.status === "failed") {
          return { status: "failed", reason: existing.reason };
        }
        const leaseExpired = deadlinePassed(existing.claimExpiresAt, now);
        if (!leaseExpired && now - existing.updatedAt < staleMs) {
          return { status: "in_progress" };
        }
        const reclaimed = await tx.query(
          `UPDATE payment_intents
              SET status = 'claimed', reason = NULL, claim_token = $1,
                  claim_expires_at = $2, updated_at = $3
            WHERE payment_key = $4 AND status = 'claimed'
              AND ((claim_expires_at IS NOT NULL AND claim_expires_at <= $3) OR updated_at <= $5)
            RETURNING claim_token`,
          [token, expiresAt, now, paymentKey, ageCutoff],
        );
        if ((reclaimed.rowCount ?? 0) === 0) return this.classify(tx, paymentKey);
        return { status: "claimed", recovered: true, token, expiresAt };
      }

      const inserted = await tx.query(
        `INSERT INTO payment_intents
           (payment_key, status, session_id, spec_hash, reason, claim_token,
            claim_expires_at, requirements_json, created_at, updated_at)
         VALUES ($1, 'claimed', NULL, $2, NULL, $3, $4, $5, $6, $6)
         ON CONFLICT (payment_key) DO NOTHING
         RETURNING claim_token`,
        [paymentKey, specHashValue, token, expiresAt, requirementsJson, now],
      );
      if ((inserted.rowCount ?? 0) === 0) {
        // Another worker created the row between the read and the insert.
        return this.classify(tx, paymentKey);
      }
      return { status: "claimed", recovered: false, token, expiresAt };
    });
  }

  /** The committed answer for an intent whose claim race we lost. */
  private async classify(tx: Tx, paymentKey: string): Promise<IntentClaimResult> {
    const intent = await this.readIntent(tx, paymentKey);
    if (!intent) return { status: "in_progress" };
    if (intent.status === "settled" && intent.sessionId) {
      return { status: "settled", sessionId: intent.sessionId };
    }
    if (intent.status === "failed") return { status: "failed", reason: intent.reason };
    return { status: "in_progress" };
  }

  async getIntent(paymentKey: string): Promise<PaymentIntentRecord | null> {
    return this.readIntent(this.conn, paymentKey);
  }

  async getPaymentRecord(paymentKey: string): Promise<PaymentRecord | null> {
    const res = await this.conn.query<Record<string, unknown>>(
      "SELECT * FROM payments WHERE payment_key = $1",
      [paymentKey],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      paymentKey: row.payment_key as string,
      network: row.network as string,
      scheme: row.scheme as string,
      asset: row.asset as string,
      amount: row.amount as string,
      payTo: row.pay_to as string,
      payer: (row.payer as string | undefined) ?? undefined,
      transaction: (row.tx as string | undefined) ?? undefined,
      mode: row.mode as PaymentMode,
    };
  }

  /**
   * Fail a payment intent, unless the ledger already says the customer was
   * served.
   *
   * The ledger guard is part of the same statement as the status change, so
   * settlement recovery cannot write a `SETTLED` row between the decision and
   * the update: there is no read-then-write window to lose. A refused fail is
   * the `LedgerSettledError` the route maps to 409; without it that pair of rows
   * is the `intent_failed_ledger_settled` divergence, which must stay reachable
   * only by an edit outside this service.
   *
   * Nothing to change is not an error: an intent that is already `settled`, or
   * that does not exist, returns normally as it always has.
   */
  async failIntent(paymentKey: string, reason: string): Promise<void> {
    const outcome = await this.conn.write<{ failed: number; ledger_status: LedgerStatus | null }>(
      `WITH failed AS (
         UPDATE payment_intents
            SET status = 'failed', reason = $1, claim_token = NULL,
                claim_expires_at = NULL, updated_at = $2
          WHERE payment_key = $3
            AND status <> 'settled'
            AND NOT EXISTS (
                  SELECT 1 FROM payment_ledger
                   WHERE payment_key = $3 AND status = 'SETTLED')
          RETURNING payment_key
       )
       SELECT (SELECT count(*) FROM failed)::int AS failed,
              (SELECT status FROM payment_ledger WHERE payment_key = $3) AS ledger_status`,
      [reason.slice(0, 500), Date.now(), paymentKey],
    );
    // The decision was the UPDATE; this only names why it matched no row, from
    // the same statement snapshot.
    const row = outcome.rows[0];
    if (row?.failed === 0 && row.ledger_status === "SETTLED") {
      throw new LedgerSettledError(paymentKey);
    }
  }

  /**
   * Record the payment, create the session and settle the intent, or refuse.
   *
   * Idempotent by design: the losing worker returns the winner's session with
   * `created: false`. A duplicate client key pair is refunded and refused
   * (`DuplicateEntitlementError`) as before; the advisory key on the
   * key pair is what stops two creates for the same pair both passing the
   * lookup, which a plain `SELECT` cannot do under `READ COMMITTED`.
   */
  async completeEntitlement(
    paymentKey: string,
    claimToken: string,
    payment: PaymentRecord,
    session: SessionRecord,
  ): Promise<{ sessionId: string; created: boolean }> {
    try {
      const outcome = await this.conn.tx<SettleOutcome>(async (tx) => {
        await tx.serialise(advisoryKey("client", `${session.clientPublicKey}\u0000${session.clientNonce}`));

        const locked = await tx.query(
          "SELECT * FROM payment_intents WHERE payment_key = $1 FOR UPDATE",
          [paymentKey],
        );
        const row = locked.rows[0];
        if (!row) throw new PaymentClaimLostError(paymentKey);
        const intent = mapIntent(row);
        if (intent.status === "settled" && intent.sessionId) {
          return { sessionId: intent.sessionId, created: false };
        }
        if (intent.status !== "claimed" || !isHeldBy(intent.claimToken, claimToken)) {
          throw new PaymentClaimLostError(paymentKey);
        }

        const now = Date.now();
        const duplicate = await this.sessions.findByClientNonce(
          tx,
          session.clientPublicKey,
          session.clientNonce,
        );
        await this.insertPayment(tx, payment, now);

        if (duplicate) {
          // The charge is recorded and refunded; the second session is refused.
          const reason = "duplicate_client_nonce";
          const refunded = payment.mode === "mock";
          await tx.query(
            `INSERT INTO payment_ledger
               (payment_key, session_id, payer, amount, asset, network, mode, status, reason,
                refund_tx, settlement_nonce, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
             ON CONFLICT DO NOTHING`,
            [
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
            ],
          );
          // Owned by this token: a concurrent reclaim cannot have its claim
          // failed out from under it.
          await tx.query(
            `UPDATE payment_intents SET status = 'failed', reason = $1, claim_token = NULL,
                claim_expires_at = NULL, updated_at = $2
              WHERE payment_key = $3 AND status = 'claimed' AND claim_token = $4`,
            [reason, now, paymentKey, claimToken],
          );
          return { sessionId: session.id, created: false, duplicateOf: duplicate };
        }

        await tx.query(
          `INSERT INTO payment_ledger
             (payment_key, session_id, payer, amount, asset, network, mode, status, reason,
              refund_tx, settlement_nonce, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'SETTLED',NULL,NULL,$8,$9,$9)`,
          [
            payment.paymentKey,
            session.id,
            payment.payer ?? null,
            payment.amount,
            payment.asset,
            payment.network,
            payment.mode,
            payment.settlementNonce ?? null,
            now,
          ],
        );
        await this.sessions.insert(tx, { ...session, runtime: session.runtime ?? DEFAULT_RUNTIME });

        // The linearisation point. Zero rows means the token moved while this
        // worker held the row lock's queue slot, so nothing above may commit.
        const settled = await tx.query(
          `UPDATE payment_intents SET status = 'settled', session_id = $1, claim_token = NULL,
              claim_expires_at = NULL, updated_at = $2
            WHERE payment_key = $3 AND status = 'claimed' AND claim_token = $4
            RETURNING session_id`,
          [session.id, now, paymentKey, claimToken],
        );
        if ((settled.rowCount ?? 0) === 0) throw new PaymentClaimLostError(paymentKey);

        // Spend commits with the ledger row, to the verified payer (#48).
        await this.budgets.recordSpend(tx, payment.payer ?? "", payment.amount, now, this.budgetWindowMs);
        return { sessionId: session.id, created: true };
      });

      const duplicateOf = outcome.duplicateOf;
      if (duplicateOf) throw new DuplicateEntitlementError(paymentKey, duplicateOf);
      return { sessionId: outcome.sessionId, created: outcome.created };
    } catch (err) {
      if (err instanceof DuplicateEntitlementError) throw err;
      if (isUniqueViolation(err)) throw new PaymentAlreadyRedeemedError(paymentKey);
      throw err;
    }
  }

  private async insertPayment(tx: Tx, payment: PaymentRecord, now: number): Promise<void> {
    await tx.query(
      `INSERT INTO payments
         (payment_key, network, scheme, asset, amount, pay_to, payer, tx, mode, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
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
      ],
    );
  }
}
