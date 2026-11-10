import type { ControllerConfig } from "../config.js";
import type { TokenBucket } from "@x402s/shared";
import type { Store } from "../store.js";
import type { RelayClient } from "../relay-client.js";
import type { CapacityService } from "../capacity/service.js";
import type { Provisioner } from "../k8s.js";

export interface ControlApiDeps {
  cfg: ControllerConfig;
  store: Store;
  relay: RelayClient;
  /**
   * Checked by readiness when supplied. Omitted by unit tests that never
   * schedule a pod; the controller always passes its real provisioner.
   */
  provisioner?: Provisioner;
  /** Optional event-driven nudge (the reconciler is not started in unit tests). */
  wake?: () => void;
  /** Optional lifecycle actions (the reconciler owns them). */
  suspend?: (id: string) => Promise<void>;
  resume?: (id: string) => Promise<void>;
  /** Capacity admission and reservation accounting. */
  capacity: CapacityService;
  /**
   * Injectable for tests. Production uses a bounded per-source-IP bucket with
   * the `INTERNAL_RATE_LIMIT` burst/refill.
   */
  internalRateLimiter?: TokenBucket;
}
