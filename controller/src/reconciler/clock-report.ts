/**
 * Reporting a wall-clock step, with the sessions it moved.
 *
 * The clock guard decides that a reading is a step, not drift. "The clock
 * jumped" alone does not tell an operator whether anything was affected, so the
 * report names the sessions whose immutable deadline falls inside the jumped
 * window: those are the ones that end early (forward) or late (backward).
 *
 * Separated from the scheduler because it is a read-only report on a side
 * channel, not a reconcile decision: it is fire-and-forget by construction, and
 * it must never be the reason a pass fails.
 */
import { log } from "@x402s/shared/runtime";
import type { ClockJump } from "../clock-guard.js";
import type { ReconcilerStore } from "../store/ports.js";

export interface ClockReportRuntime {
  readonly store: Pick<ReconcilerStore, "listNonTerminal">;
  /** How many steps the guard has seen, so a flapping clock shows in the count. */
  readonly jumpCount: number;
}

export async function reportClockJump(
  deps: ClockReportRuntime,
  jump: ClockJump,
): Promise<void> {
  const low = Math.min(jump.from, jump.to);
  const high = Math.max(jump.from, jump.to);
  let affected: string[] = [];
  try {
    affected = (await deps.store.listNonTerminal())
      .filter(
        (session) =>
          session.leaseExpiresAt !== null &&
          session.leaseExpiresAt >= low &&
          session.leaseExpiresAt <= high,
      )
      .map((session) => session.id);
  } catch {
    // Reporting must never be the reason a reconcile pass fails.
  }
  log.warn("clock_skew_detected", {
    from: new Date(jump.from).toISOString(),
    to: new Date(jump.to).toISOString(),
    deltaMs: jump.deltaMs,
    direction: jump.direction,
    affectedSessions: affected.length,
    affectedSessionIds: affected.slice(0, 20),
    jumps: deps.jumpCount,
  });
}
