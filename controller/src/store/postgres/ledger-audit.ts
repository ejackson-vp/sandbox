/**
 * The ledger audit's read-only snapshot, for Postgres.
 *
 * Two statements, no transaction, no lock, no write, and both run on the
 * dedicated read-only pool in `pg.ts` with a timeout sized well under a scrape
 * timeout. The audit samples on a timer (`LEDGER_AUDIT_INTERVAL_MS`), so a slow
 * read can delay one sample, never a scrape, and it can never hold a
 * writer-pool connection.
 *
 * The payment query is one round trip (two CTEs): the intent divergences, read
 * in full, and the duplicate claims, which are grouped before they leave SQL so
 * a member of a nonce pair cannot be hidden. The session query is the second
 * round trip. Both are issued on the same connection, one after the other.
 *
 * The intent predicate is a superset of the pure module's rules, not a second
 * copy of the decision. It exists so the read returns the rows that can diverge
 * instead of every payment ever made; `auditLedger` still decides. A new reason
 * in the pure module needs a clause here too, which the Postgres test catches by
 * seeding that shape.
 */
import { MAX_SESSION_LIFETIME_SECONDS, type SessionState } from "@x402s/shared/protocol";
import type {
  IntentLedgerSnapshot,
  LedgerAuditLimits,
  LedgerAuditSnapshot,
  LiveRefundClaim,
  SessionLifetimeSnapshot,
} from "../../ledger-audit.js";
import { NON_TERMINAL_STATE_SQL, type IntentStatus, type LedgerStatus } from "../models.js";
import type { PgConnection } from "./pg.js";

interface PaymentAuditRow {
  kind: "intent" | "claim";
  payment_key: string;
  intent_status: string | null;
  ledger_status: string | null;
  settlement_nonce: string | null;
}

interface SessionAuditRow {
  id: string;
  state: string;
  created_at: number;
  lease_expires_at: number | null;
  max_lifetime_seconds: number | null;
}

/**
 * `settled` with no ledger row, and `failed` with a `SETTLED` ledger row. Both
 * are reads of `payment_intents` joined to `payment_ledger` on the primary key,
 * so the join itself is a primary-key lookup and the scan is the table.
 *
 * Unbounded, deliberately. The cap this query used to carry bounded the rows
 * returned, not the scan, and the counts are the metric: a cap turns a large
 * incident into a floor that looks smaller than it is. In a healthy ledger the
 * predicate matches nothing, so the unbounded result set is only large when
 * something is already badly wrong, which is exactly when the exact count is
 * worth having. The pass is off the scrape path and single-flights; the
 * read-only pool's statement timeout still bounds it.
 *
 * The claiming half is unbounded and grouped in SQL. A capped read of
 * `REFUND_SENDING` rows could return one member of a nonce pair and hide the
 * duplicate in JS, which is the exact incident the check exists for: ADR 0011
 * keeps ambiguous rows in `REFUND_SENDING` indefinitely, so the worse the
 * backlog, the blinder a capped check becomes. `HAVING count(*) > 1` returns only
 * real duplicates, so its output is small without a limit.
 */
const PAYMENT_AUDIT_SQL = `
  WITH divergent AS (
    SELECT i.payment_key,
           i.status AS intent_status,
           l.status AS ledger_status,
           l.settlement_nonce
      FROM payment_intents i
      LEFT JOIN payment_ledger l ON l.payment_key = i.payment_key
     WHERE (i.status = 'settled' AND l.payment_key IS NULL)
        OR (i.status = 'failed' AND l.status = 'SETTLED')
  ),
  live AS (
    SELECT payment_key, settlement_nonce
      FROM payment_ledger
     WHERE status = 'REFUND_SENDING' AND settlement_nonce IS NOT NULL
  ),
  duplicated AS (
    SELECT settlement_nonce
      FROM live
     GROUP BY settlement_nonce
    HAVING count(*) > 1
  )
  SELECT 'intent' AS kind, payment_key, intent_status, ledger_status, settlement_nonce
    FROM divergent
  UNION ALL
  SELECT 'claim' AS kind, l.payment_key, NULL AS intent_status, 'REFUND_SENDING' AS ledger_status,
         l.settlement_nonce
    FROM live l
    JOIN duplicated d USING (settlement_nonce)
  ORDER BY kind, payment_key
`;

/**
 * A session is stale when its effective deadline is past `now` minus the grace.
 * The `COALESCE` mirrors `sessionDeadline()`: the lease when it exists,
 * otherwise the wall-clock cap. `$2` is the protocol maximum, so a null
 * `max_lifetime_seconds` behaves exactly as the pure module does.
 *
 * Deliberately unbounded. The rows are stale live sessions, bounded by admission
 * capacity rather than by history, and a cap here could hide a whole phase: 500
 * stale TERMINATING rows would mask a thousand stale PAID rows and report a
 * clean zero for the phase that matters. The counts are the metric, so they are
 * exact.
 */
const STALE_SESSION_SQL = `
  SELECT id, state, created_at, lease_expires_at, max_lifetime_seconds
    FROM sessions
   WHERE state IN (${NON_TERMINAL_STATE_SQL})
     AND COALESCE(
           lease_expires_at,
           created_at + COALESCE(max_lifetime_seconds, $2) * 1000
         ) < $1
`;

export class PgLedgerAuditRepository {
  constructor(private readonly conn: PgConnection) {}

  async read(now: number, limits: LedgerAuditLimits): Promise<LedgerAuditSnapshot> {
    // One connection, one statement at a time, so a slow read holds at most one
    // audit connection and never a writer-pool one.
    const payments = await this.conn.queryReadOnly<PaymentAuditRow>(PAYMENT_AUDIT_SQL);
    const sessions = await this.conn.queryReadOnly<SessionAuditRow>(STALE_SESSION_SQL, [
      now - limits.sessionGraceMs,
      MAX_SESSION_LIFETIME_SECONDS,
    ]);

    const intents: IntentLedgerSnapshot[] = [];
    const liveRefunds: LiveRefundClaim[] = [];
    for (const row of payments.rows) {
      if (row.kind === "intent") {
        intents.push({
          paymentKey: row.payment_key,
          intentStatus: row.intent_status as IntentStatus,
          ledgerStatus: row.ledger_status as LedgerStatus | null,
        });
      } else {
        liveRefunds.push({
          paymentKey: row.payment_key,
          settlementNonce: row.settlement_nonce,
        });
      }
    }

    return {
      intents,
      liveRefunds,
      sessions: sessions.rows.map(
        (row): SessionLifetimeSnapshot => ({
          sessionId: row.id,
          state: row.state as SessionState,
          createdAt: Number(row.created_at),
          leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
          maxLifetimeSeconds:
            row.max_lifetime_seconds === null ? null : Number(row.max_lifetime_seconds),
        }),
      ),
    };
  }
}
