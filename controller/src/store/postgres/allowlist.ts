/**
 * The payer allowlist, for Postgres (ADR 0013).
 *
 * A free session is granted on the strength of a proven wallet address, so the
 * decision has to be one atomic answer:
 *
 *  - the row must exist and not be disabled;
 *  - the requested tier must be at or below the entry's `max_tier`;
 *  - the entry's `max_concurrent` must not already be in use.
 *
 * The count in the last check is a read-then-write, which `READ COMMITTED` does
 * not make stable. The address-scoped advisory lock is what makes two
 * concurrent creates for one address serialise, so the ceiling cannot be
 * exceeded by a race. The lock is per address, not global: one allowlisted
 * wallet cannot stall another.
 *
 * `max_concurrent = 0` means "no extra ceiling": the shared per-payer and
 * global concurrency budgets still apply.
 */
import { tierWithinMax } from "@x402s/shared/payment";
import type { SessionTier } from "@x402s/shared/protocol";
import {
  NON_TERMINAL_STATE_SQL,
  type AllowlistDecision,
  type AllowlistEntryInput,
  type PayerAllowlistEntry,
} from "../models.js";
import { advisoryKey, type PgConnection } from "./pg.js";

interface AllowlistRow {
  address: string;
  label: string;
  max_tier: string;
  max_concurrent: number;
  created_at: number;
  disabled_at: number | null;
}

function mapEntry(row: AllowlistRow): PayerAllowlistEntry {
  return {
    address: row.address,
    label: row.label,
    maxTier: row.max_tier as SessionTier,
    maxConcurrent: Number(row.max_concurrent),
    createdAt: Number(row.created_at),
    disabledAt: row.disabled_at === null ? null : Number(row.disabled_at),
  };
}

export class PgAllowlistRepository {
  constructor(private readonly conn: PgConnection) {}

  /**
   * The entitlement decision. Any refusal is a normal 402 path for the caller,
   * never a grant: the default is `not_allowlisted`.
   */
  async authorize(address: string, tier: SessionTier): Promise<AllowlistDecision> {
    const normalized = address.toLowerCase();
    return this.conn.tx(async (tx) => {
      await tx.serialise(advisoryKey("allowlist", normalized));
      const found = await tx.query<AllowlistRow>(
        "SELECT * FROM payer_allowlist WHERE address = $1",
        [normalized],
      );
      const row = found.rows[0];
      if (!row) return { allowed: false, reason: "not_allowlisted" };
      const entry = mapEntry(row);
      if (entry.disabledAt !== null) return { allowed: false, reason: "disabled" };
      if (!tierWithinMax(tier, entry.maxTier)) {
        return { allowed: false, reason: "tier_not_allowed" };
      }
      if (entry.maxConcurrent > 0) {
        const active = await tx.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n
             FROM sessions s
             JOIN payment_ledger l ON l.session_id = s.id
            WHERE l.source = 'allowlist'
              AND lower(l.payer) = $1
              AND s.state IN (${NON_TERMINAL_STATE_SQL})`,
          [normalized],
        );
        if (Number(active.rows[0]?.n ?? 0) >= entry.maxConcurrent) {
          return { allowed: false, reason: "concurrency_exhausted" };
        }
      }
      return {
        allowed: true,
        label: entry.label,
        maxTier: entry.maxTier,
        maxConcurrent: entry.maxConcurrent,
      };
    });
  }

  async list(): Promise<PayerAllowlistEntry[]> {
    const res = await this.conn.query<AllowlistRow>(
      "SELECT * FROM payer_allowlist ORDER BY created_at ASC, address ASC",
    );
    return res.rows.map(mapEntry);
  }

  /**
   * Add or replace an entry. A re-add clears `disabled_at`, which is the
   * documented way to re-enable a wallet: the row keeps its address, so the
   * audit trail is the ledger, not this table.
   */
  async upsert(input: AllowlistEntryInput, now: number): Promise<PayerAllowlistEntry> {
    const normalized = input.address.toLowerCase();
    const res = await this.conn.write<AllowlistRow>(
      `INSERT INTO payer_allowlist (address, label, max_tier, max_concurrent, created_at, disabled_at)
       VALUES ($1, $2, $3, $4, $5, NULL)
       ON CONFLICT (address) DO UPDATE
         SET label = EXCLUDED.label,
             max_tier = EXCLUDED.max_tier,
             max_concurrent = EXCLUDED.max_concurrent,
             disabled_at = NULL
       RETURNING *`,
      [normalized, input.label, input.maxTier, input.maxConcurrent, now],
    );
    const row = res.rows[0];
    if (!row) throw new Error("allowlist upsert returned no row");
    return mapEntry(row);
  }

  /** Disable, never delete: the ledger row that points here keeps its meaning. */
  async disable(address: string, now: number): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE payer_allowlist SET disabled_at = $1
        WHERE address = $2 AND disabled_at IS NULL`,
      [now, address.toLowerCase()],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
