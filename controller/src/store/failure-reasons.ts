/**
 * Bounded provisioning-failure reasons for the metrics label.
 *
 * Free-text reasons reach the store from the interpreter, so anything not on
 * this list collapses to `other`: a new string must not grow the label's
 * cardinality by accident. Shared by both adapters so the metric is identical
 * whichever backend is configured.
 */
const PROVISION_FAILURE_REASONS = new Set([
  "provisioning_timeout",
  "provisioning_queue_timeout",
  "warm_claim_timeout",
  "pod_terminated",
  "checkpoint_missing",
  "guest_exited",
  "reaped",
  "guest_protocol_unsupported",
  "guest_measurement_not_allowed",
  "guest_attestation_rejected",
]);

export function boundedFailureReason(reason: string): string {
  return PROVISION_FAILURE_REASONS.has(reason) ? reason : "other";
}
