/**
 * Guest measurement pinning.
 *
 * Empty (the default) means measurement is not pinned, matching the behaviour
 * before this option existed. A malformed entry fails startup rather than
 * silently unpinning: sha256 hex only.
 */
import type { ControllerConfig } from "./types.js";

export type AttestationSettings = Pick<ControllerConfig, "guestMeasurementAllowlist">;

export function parseGuestMeasurementAllowlist(
  env: NodeJS.ProcessEnv,
): AttestationSettings {
  const values = (env.GUEST_MEASUREMENT_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  for (const value of values) {
    // sha256 hex only: a typo must fail startup, never silently unpin.
    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`invalid GUEST_MEASUREMENT_ALLOWLIST entry ${value}`);
    }
  }
  return { guestMeasurementAllowlist: values };
}
