import type { Store } from "../store.js";

/**
 * Narrow store surfaces, one per consumer. A module declares only the methods
 * it uses; Store still implements all of them. This is a type-level boundary:
 * adding a method to Store does not silently widen any module's dependency.
 */
export type ProvisioningStore = Pick<
  Store,
  | "listNonTerminal"
  | "mergeTimings"
  | "requestTermination"
  | "setNodeName"
  | "setProvisioning"
  | "setProvisioningPod"
  | "setReady"
  | "setRelayToken"
  | "setWorkspacePvc"
>;

export type WarmPoolStore = Pick<
  Store,
  "mergeTimings" | "setProvisioning" | "setRelayToken"
>;

export type TerminationStore = Pick<
  Store,
  | "clearPod"
  | "clearWorkspacePvc"
  | "finalizeTermination"
  | "getSession"
  | "markRelayPurged"
  | "mergeTimings"
  | "requestTermination"
  // RefundService shares this store.
  | "getLedgerBySession"
  | "listUnrefundedTerminalBeforeReady"
  | "markRefundPending"
  | "markRefunded"
>;

export type LifecycleStore = Pick<
  Store,
  | "clearPod"
  | "clearWorkspacePvc"
  | "getSession"
  | "listNonTerminal"
  | "listTerminalWithPvc"
  | "markResuming"
  | "markSuspended"
  | "markSuspending"
  | "requestTermination"
  | "setNodeName"
>;

export type RefundStore = Pick<
  Store,
  | "getLedgerBySession"
  | "getSession"
  | "listUnrefundedTerminalBeforeReady"
  | "markRefundPending"
  | "markRefunded"
>;

export type SessionViewStore = Pick<Store, "getPayment" | "getSession">;

export type CapacityStore = Pick<Store, "getSession" | "reservations">;
