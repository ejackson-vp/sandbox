import type { ControllerConfig } from "./config.js";
import type { Provisioner } from "./k8s.js";
import type { RelayClient } from "./relay-client.js";
import type { Store } from "./store.js";

/** The narrow view of the reconciler that policy modules are allowed to use. */
export interface ReconcilerContext {
  readonly cfg: ControllerConfig;
  readonly store: Store;
  readonly provisioner: Provisioner;
  readonly relay: RelayClient;
  now(): number;
  serviceAddress(name: string): Promise<{ host: string; port: number } | null>;
}
