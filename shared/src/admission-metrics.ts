/**
 * The create kill switch's metric families (schema v21).
 *
 * Both processes publish them, so the names live here rather than in either
 * workspace: the API counts refusals (it is the process that refuses), and both
 * processes publish the gauge from the last switch state they read, so a flip
 * shows up on a dashboard without waiting for create traffic.
 *
 * Labels stay bounded on purpose. The operator's reason is free text and the
 * actor is a name; neither is ever a label value. `sandbox_creates_disabled` has
 * no labels at all, and the refusal counter only carries the refusal code.
 */
import type { MetricsRegistry } from "./metrics.js";

export const CREATES_DISABLED_GAUGE = "sandbox_creates_disabled";
export const CREATE_REFUSALS_TOTAL = "sandbox_create_refusals_total";

/** Publish the switch's effective state: 1 means new creates are refused. */
export function publishCreateSwitch(
  registry: MetricsRegistry,
  enabled: boolean,
): void {
  registry
    .gauge(CREATES_DISABLED_GAUGE, "1 when new session creates are refused by the kill switch")
    .set({}, enabled ? 1 : 0);
}
