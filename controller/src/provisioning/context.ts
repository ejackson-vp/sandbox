/**
 * The provisioning use case's view of the reconciler.
 *
 * Narrower than `ReconcilerContext`: the create path and the readiness
 * handshake read and write provisioning rows, never the whole scheduler store.
 * Kept in one place so both halves of the use case are typed against the same
 * contract instead of two copies that can drift.
 */
import type { ReconcilerContext } from "../reconciler-context.js";
import type { EffectStore, ProvisioningStore } from "../store/ports.js";

export type ProvisioningContext = Omit<ReconcilerContext, "store"> & {
  store: ProvisioningStore & EffectStore;
};
