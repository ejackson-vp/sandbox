/**
 * The ledger audit's sampling cadence.
 *
 * The audit reads the whole `payment_intents` table on every pass, so its cost
 * grows with the ledger rather than with the number of incidents. It used to
 * run inside the 15 s metrics scrape; that is about 1.3 s at 10M intents, per
 * replica, forever. Five minutes keeps a divergence visible well inside an
 * on-call rotation while cutting the read by a factor of 20.
 */
import { envInt as int } from "@x402s/shared/env";
import type { ControllerConfig } from "./types.js";

type LedgerAuditSettings = Pick<ControllerConfig, "ledgerAuditIntervalMs">;

export const DEFAULT_LEDGER_AUDIT_INTERVAL_MS = 300_000;

/**
 * The lower bound is a second: faster than that costs more in table scans than
 * a 15 s scrape can show, and an operator who wants it is probably debugging
 * rather than running a ledger. The upper bound is an hour, past which the
 * freshness alert fires between samples by design.
 */
export function parseLedgerAudit(env: NodeJS.ProcessEnv): LedgerAuditSettings {
  return {
    ledgerAuditIntervalMs: int(
      env.LEDGER_AUDIT_INTERVAL_MS,
      DEFAULT_LEDGER_AUDIT_INTERVAL_MS,
      1_000,
      3_600_000,
    ),
  };
}
