/**
 * The metric families this process owns.
 *
 * Registered eagerly, before the first request, so a scrape taken while the
 * kill switch is off reads 0 instead of an absent family, and an alert rule can
 * rate against a counter that starts at zero. The HTTP, auth and rate-limit
 * families live in `@x402s/shared/runtime` so every role has the same names.
 */
import {
  CREATE_REFUSALS_TOTAL,
  CREATES_DISABLED_GAUGE,
  LATENCY_BUCKETS,
  metrics,
  registerRequestMetrics,
} from "@x402s/shared/runtime";
import { ALLOWLIST_DECISIONS_TOTAL } from "../use-cases/create-session-allowlist.js";

export function registerApiMetrics(): void {
  registerRequestMetrics(metrics);
  metrics.histogram("sandbox_payment_verify_duration_seconds", "Facilitator payment verification", LATENCY_BUCKETS);
  metrics.histogram("sandbox_payment_settle_duration_seconds", "Facilitator settlement", LATENCY_BUCKETS);
  metrics.histogram("sandbox_session_create_duration_seconds", "Create request duration", LATENCY_BUCKETS);
  metrics.counter("sandbox_sessions_created_total", "Session create requests by outcome");
  metrics.counter("sandbox_sessions_total", "Sessions created by entitlement source");
  // The kill switch: a refusal counter that starts at zero is what an alert
  // rule can rate against.
  metrics.gauge(CREATES_DISABLED_GAUGE, "1 when new session creates are refused by the kill switch");
  metrics.counter(CREATE_REFUSALS_TOTAL, "Create requests refused by the kill switch path");
  // The free tier has no volume ceiling, so its counters are the only place a
  // shared wallet shows up.
  metrics.counter(ALLOWLIST_DECISIONS_TOTAL, "Allowlist entitlement decisions by outcome");
}
