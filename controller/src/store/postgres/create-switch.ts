/**
 * The create kill switch, for Postgres (schema v21).
 *
 * One row, `id = 1`, so the switch has exactly one value and no reader has to
 * decide which row wins. Three rules make it safe to rely on during an incident:
 *
 *  - a missing row is not an error: it means no operator has flipped it, so
 *    creates are admitted. That is what every database that upgrades through
 *    v21 looks like;
 *  - an expiry is evaluated on read, against the reader's own clock, so the
 *    switch turns itself off without a worker, a cron or a write. The row keeps
 *    `expires_at` so `status` can say when it expired;
 *  - a write is one upsert, so two operators racing each other leave one row
 *    with one outcome rather than two "last" rows.
 *
 * The row is the state; the operator's reason and actor ride along with it so
 * the next person at 2am can read why creates were refused without the logs.
 */
import type {
  CreateSwitchState,
  CreateSwitchWrite,
  CreateSwitchWriteResult,
} from "../models.js";
import type { PgConnection } from "./pg.js";

/** The one fixed row. The CHECK constraint in the schema enforces the same. */
const SWITCH_ROW_ID = 1;

interface SwitchRow {
  enabled: boolean;
  reason: string;
  actor: string;
  changed_at: number;
  expires_at: number | null;
}

/**
 * The state when no row has ever been written.
 *
 * A function rather than a constant: the object is returned to callers that
 * serialise it, and a shared mutable literal is one editing bug away from a
 * second source of truth.
 */
export function createSwitchAbsent(): CreateSwitchState {
  return {
    enabled: false,
    reason: "",
    actor: "",
    changedAt: null,
    expiresAt: null,
    expired: false,
  };
}

function mapState(row: SwitchRow, nowMs: number): CreateSwitchState {
  const expiresAt = row.expires_at === null ? null : Number(row.expires_at);
  const expired = row.enabled && expiresAt !== null && expiresAt <= nowMs;
  return {
    // An expired row is off, whatever the column says. Evaluating it here, not
    // in a sweeper, is what makes the expiry exact.
    enabled: row.enabled && !expired,
    reason: row.reason,
    actor: row.actor,
    changedAt: Number(row.changed_at),
    expiresAt,
    expired,
  };
}

export class PgCreateSwitchRepository {
  constructor(private readonly conn: PgConnection) {}

  /** Reads run outside the writer guard: a standby can answer this too. */
  async read(nowMs: number): Promise<CreateSwitchState> {
    const res = await this.conn.query<SwitchRow>(
      "SELECT enabled, reason, actor, changed_at, expires_at FROM create_switch WHERE id = $1",
      [SWITCH_ROW_ID],
    );
    const row = res.rows[0];
    return row ? mapState(row, nowMs) : createSwitchAbsent();
  }

  /**
   * Enable or disable. An enable whose `until` is not in the future is refused
   * instead of written: the row would say "on" and behave off, which is the
   * one shape an operator cannot debug from `status`.
   */
  async write(input: CreateSwitchWrite, nowMs: number): Promise<CreateSwitchWriteResult> {
    if (input.enabled && input.until !== null && input.until <= nowMs) {
      return { ok: false, reason: "until_in_past" };
    }
    const expiresAt = input.enabled ? input.until : null;
    const res = await this.conn.write<SwitchRow>(
      `INSERT INTO create_switch (id, enabled, reason, actor, changed_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             reason = EXCLUDED.reason,
             actor = EXCLUDED.actor,
             changed_at = EXCLUDED.changed_at,
             expires_at = EXCLUDED.expires_at
       RETURNING enabled, reason, actor, changed_at, expires_at`,
      [SWITCH_ROW_ID, input.enabled, input.reason, input.actor, nowMs, expiresAt],
    );
    const row = res.rows[0];
    if (!row) throw new Error("create switch upsert returned no row");
    return { ok: true, state: mapState(row, nowMs) };
  }
}
