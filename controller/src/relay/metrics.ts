/**
 * Relay registry metrics.
 *
 * The gauges are refreshed at scrape time because the registry is the source of
 * truth. Disconnect reasons are a closed enum derived from the WebSocket close
 * code, never from the guest-provided text.
 */
import { metrics, type MetricsRegistry } from "@x402s/shared/runtime";

export const RELAY_DISCONNECT_REASONS = [
  "normal",
  "going_away",
  "policy_violation",
  "unsupported_data",
  "message_too_big",
  "internal_error",
  "abnormal",
  "other",
] as const;

export type RelayDisconnectReason = (typeof RELAY_DISCONNECT_REASONS)[number];

export function disconnectReasonLabel(code: number | undefined): RelayDisconnectReason {
  switch (code) {
    case 1000:
      return "normal";
    case 1001:
      return "going_away";
    case 1003:
      return "unsupported_data";
    case 1008:
      return "policy_violation";
    case 1009:
      return "message_too_big";
    case 1011:
      return "internal_error";
    case 1006:
    case 0:
    case undefined:
      return "abnormal";
    default:
      return "other";
  }
}

export function registerRelayMetrics(registry: MetricsRegistry = metrics): void {
  registry.gauge("sandbox_relay_sessions", "Registered relay sessions");
  registry.gauge("sandbox_relay_pending_requests", "Requests awaiting a guest response");
  registry.gauge("sandbox_relay_active_requests", "Operations the guests report as running");
  registry.counter("sandbox_relay_reconnects_total", "Guest reconnections to an existing registration");
  registry.counter("sandbox_relay_disconnects_total", "Guest disconnections by close reason");
  registry.counter(
    "sandbox_relay_frames_withdrawn_total",
    "Frames withdrawn from the pending set after a recovery epoch increase",
  );
}

/** The counters the scrape reads. Declared here so metrics does not import the registry. */
export interface RelayMetricsSource {
  size(): number;
  pendingTotal(): number;
  activeTotal(): number;
}

export function collectRelayMetrics(registry: MetricsRegistry, relay: RelayMetricsSource): void {
  registry.gauge("sandbox_relay_sessions", "Registered relay sessions").set({}, relay.size());
  registry
    .gauge("sandbox_relay_pending_requests", "Requests awaiting a guest response")
    .set({}, relay.pendingTotal());
  registry
    .gauge("sandbox_relay_active_requests", "Operations the guests report as running")
    .set({}, relay.activeTotal());
}
