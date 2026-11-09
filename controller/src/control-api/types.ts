import type { ControllerConfig } from "../config.js";
import type { Store } from "../store.js";
import type { RelayClient } from "../relay-client.js";
import type { CapacityService } from "../capacity/service.js";

export interface ControlApiDeps {
  cfg: ControllerConfig;
  store: Store;
  relay: RelayClient;
  /** Optional event-driven nudge (the reconciler is not started in unit tests). */
  wake?: () => void;
  /** Optional lifecycle actions (the reconciler owns them). */
  suspend?: (id: string) => Promise<void>;
  resume?: (id: string) => Promise<void>;
  /** Capacity admission and reservation accounting. */
  capacity: CapacityService;
}
