/**
 * The ledger audit's read-only snapshot, for Postgres.
 *
 * Two statements, no transaction, no lock, no write. `read()` is called from
 * the metrics scrape path, so it must never wait behind a hot table: plain
 * `SELECT`s in autocommit mode take no row locks and a statement timeout is the
 * only thing an operator needs to add on the server.
 *
 * The predicates here are a superset of the pure module's rules, not a second
 * copy of the decision. They exist so the read returns the rows that can
 * diverge instead of every payment ever made; `auditLedger` still decides, and
 * the table test is what pins the rules. A new reason in the pure module needs a
 * clause here too, which the Postgres test catches by seeding that shape.
 *
 * The payment query is one round trip (two CTEs), the session query is the
 * second, and they are issued together.
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
     ORDER BY i.updated_at DESC
     LIMIT $1
  ),
  claiming AS (
    SELECT payment_key, settlement_nonce
      FROM payment_ledger
     WHERE status = 'REFUND_SENDING'
     ORDER BY updated_at DESC
     LIMIT $1
  )
  SELECT 'intent' AS kind, payment_key, intent_status, ledger_status, settlement_nonce
    FROM divergent
  UNION ALL
  SELECT 'claim' AS kind, payment_key, NULL AS intent_status, 'REFUND_SENDING' AS ledger_status,
         settlement_nonce
    FROM claiming
`;

/**
 * A session is stale when its effective deadline is past `now` minus the grace.
 * The `COALESCE` mirrors `sessionDeadline()`: the lease when it exists,
 * otherwise the wall-clock cap. `$3` is the protocol maximum, so a null
 * `max_lifetime_seconds` behaves exactly as the pure module does.
 */
const STALE_SESSION_SQL = `
  SELECT id, state, created_at, lease_expires_at, max_lifetime_seconds
    FROM sessions
   WHERE state IN (${NON_TERMINAL_STATE_SQL})
     AND COALESCE(
           lease_expires_at,
           created_at + COALESCE(max_lifetime_seconds, $3) * 1000
         ) < $1
   ORDER BY updated_at ASC
   LIMIT $2
`;

export class PgLedgerAuditRepository {
  constructor(private readonly conn: PgConnection) {}

  async read(now: number, limits: LedgerAuditLimits): Promise<LedgerAuditSnapshot> {
    const [payments, sessions] = await Promise.all([
      this.conn.query<PaymentAuditRow>(PAYMENT_AUDIT_SQL, [limits.maxRows]),
      this.conn.query<SessionAuditRow>(STALE_SESSION_SQL, [
        now - limits.sessionGraceMs,
        limits.maxRows,
        MAX_SESSION_LIFETIME_SECONDS,
      ]),
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
