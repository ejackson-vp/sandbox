import type { ControllerConfig } from "../config.js";
import type { TokenBucket } from "@x402s/shared/runtime";
import type { ControlApiStore } from "../store/ports.js";
import type { RelayClient } from "../relay-client.js";
import type { CapacityService } from "../capacity/service.js";
import type { Provisioner } from "../k8s.js";
import type { Leadership } from "../leadership.js";

export interface ControlApiDeps {
  cfg: ControllerConfig;
  store: ControlApiStore;
  relay: RelayClient;
  /**
   * Checked by readiness when supplied. Omitted by unit tests that never
   * schedule a pod; the controller always passes its real provisioner.
   */
  provisioner?: Provisioner;
  /**
   * Writer role, checked by readiness. Omitted by unit tests and local runs
   * that have no election to take part in.
   */
  leadership?: Pick<Leadership, "isLeader" | "onChange">;
  /**
   * True once the writer role has been acquired and startup recovery has
   * finished. A replica can hold the Lease while this is false, so without it
   * readiness answers 200 while the reconcile loop has not started.
   *
   * Omitted by unit tests and local runs, where there is no acquire step.
   */
  acquireSettled?: () => boolean;
  /** Optional event-driven nudge (the reconciler is not started in unit tests). */
  wake?: () => void;
  /**
   * Isolation boundary the process verified at startup. Present on the
   * controller and `all` roles, absent on relay/proxy pods, which neither
   * provision nor read the RuntimeClass. Echoed by `/internal/healthz` so a
   * post-incident audit can see the handler without the pod logs.
   */
  runtime?: {
    executionMode: string;
    runtimeClass: string;
    /** Verified handler, or null when the check does not apply (dev mode). */
    handler: string | null;
  };
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
