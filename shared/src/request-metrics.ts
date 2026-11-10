/**
 * Request admission families shared by all roles.
 *
 * `reason` and `scope` are closed enums: these are the only values any caller
 * may pass, so a new rejection path must be added here first.
 */
import { metrics, type MetricsRegistry } from "./metrics.js";
import { registerHttpMetrics } from "./http-metrics.js";

export const AUTH_FAILURE_REASONS = [
  "capability_missing",
  "capability_invalid",
  "capability_expired",
  "client_proof_missing",
  "client_proof_invalid",
  "internal_token",
  "relay_admin_token",
] as const;

export type AuthFailureReason = (typeof AUTH_FAILURE_REASONS)[number];

export const RATE_LIMIT_SCOPES = ["ip", "payer", "read", "internal", "relay"] as const;

export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

export function registerRequestMetrics(registry: MetricsRegistry = metrics): void {
  registerHttpMetrics(registry);
  registry.counter("sandbox_auth_failures_total", "Rejected authentication attempts by reason");
  registry.counter("sandbox_rate_limited_total", "Rate-limit rejections by admission scope");
}

export function recordAuthFailure(
  reason: AuthFailureReason,
  registry: MetricsRegistry = metrics,
): void {
  registry
    .counter("sandbox_auth_failures_total", "Rejected authentication attempts by reason")
    .inc({ reason });
}

export function recordRateLimited(
  scope: RateLimitScope,
  registry: MetricsRegistry = metrics,
): void {
  registry
    .counter("sandbox_rate_limited_total", "Rate-limit rejections by admission scope")
    .inc({ scope });
}
