/**
 * The reconciler wires the data-plane resolver into the context its use cases
 * receive. A shorter parameter list is assignable in TypeScript, so
 *
 *   serviceAddress: (name, shard) => this.serviceAddress(name, shard)
 *
 * compiled while dropping the workload prefix. Every shard lookup then matched
 * `relay-headless-<n>` against endpoints named `relay-0` and found nothing, and
 * provisioning deferred until the client timed out.
 *
 * This exercises the real Reconciler context rather than a hand-built one, which
 * is the only way to catch a wiring fault of that shape.
 */
import { describe, expect, it, vi } from "vitest";
import { loadControllerConfig } from "../../controller/src/config.js";
import { Reconciler } from "../../controller/src/reconciler.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import { freshStore, testDatabaseUrl } from "../helpers/test-store.js";

function config(extra: Record<string, string> = {}) {
  return loadControllerConfig({
    ADMIN_TOKEN: "unit-admin-token-0123456789",
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DATABASE_URL: testDatabaseUrl(),
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
    ...extra,
  });
}

describe("reconciler data-plane resolver wiring", () => {
  it("forwards the workload pod prefix to the provisioner", async () => {
    const store = await freshStore();
    try {
      const getServiceAddress = vi.fn(async () => ({ host: "10.1.0.9", port: 8443 }));
      const getStableServiceAddress = vi.fn(async () => ({ host: "10.96.1.9", port: 8443 }));
      const reconciler = new Reconciler({
        cfg: config({ RELAY_REPLICAS: "2", PROXY_REPLICAS: "2" }),
        store,
        provisioner: { getServiceAddress, getStableServiceAddress } as unknown as Provisioner,
        relay: { isReady: async () => true } as unknown as RelayClient,
        now: () => Date.now(),
      });
      const provisioning = (
        reconciler as unknown as {
          provisioning: { endpointsFor(id: string): Promise<unknown> };
        }
      ).provisioning;

      await provisioning.endpointsFor("sbx_prefix_probe");

      // Readiness and address are two lookups on purpose: the headless
      // EndpointSlice proves the shard has a ready backend, and the stable
      // ClusterIP is what the guest dials. Both need the workload prefix, since
      // the shard numbers the Service (`relay-<n>`).
      expect(getServiceAddress).toHaveBeenCalledWith(
        "relay-headless",
        expect.any(Number),
        "relay",
      );
      expect(getStableServiceAddress).toHaveBeenCalledWith("relay", expect.any(Number), "relay");
      // The proxy is still resolved as an endpoint, whose hostname comes from
      // the workload, so the prefix must survive there too.
      expect(getServiceAddress).toHaveBeenCalledWith(
        "egress-proxy-headless",
        expect.any(Number),
        "egress-proxy",
      );
    } finally {
      await store.close();
    }
  });

  it("uses the ClusterIP names, with no prefix, when there is one replica", async () => {
    const store = await freshStore();
    try {
      const getServiceAddress = vi.fn(async () => ({ host: "10.1.0.9", port: 8443 }));
      const getStableServiceAddress = vi.fn(async () => ({ host: "10.96.1.9", port: 8443 }));
      const reconciler = new Reconciler({
        cfg: config(),
        store,
        provisioner: { getServiceAddress, getStableServiceAddress } as unknown as Provisioner,
        relay: { isReady: async () => true } as unknown as RelayClient,
        now: () => Date.now(),
      });
      const provisioning = (
        reconciler as unknown as {
          provisioning: { endpointsFor(id: string): Promise<unknown> };
        }
      ).provisioning;

      await provisioning.endpointsFor("sbx_prefix_probe");

      // At one replica the guest URL is the shardless `relay` ClusterIP; the
      // endpoint lookup still runs as the readiness gate, and the proxy keeps
      // the endpoint lookup.
      expect(getStableServiceAddress).toHaveBeenCalledWith("relay", undefined, undefined);
      expect(getServiceAddress).toHaveBeenCalledWith("relay", undefined, undefined);
      expect(getServiceAddress).toHaveBeenCalledWith("egress-proxy", undefined, undefined);
    } finally {
      await store.close();
    }
  });
});
