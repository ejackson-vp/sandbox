/**
 * EndpointSlice resolution.
 *
 * A Kubernetes API is not needed: the provisioner only reads a Service and its
 * EndpointSlices, so two small fakes stand in for the generated clients.
 */
import { describe, expect, it } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { KubeProvisioner } from "../../controller/src/k8s.js";

interface FakeEndpoint {
  addresses?: string[];
  hostname?: string;
  ready?: boolean;
}

function provisioner(
  service: { port?: number; clusterIP?: string },
  endpoints: FakeEndpoint[],
): KubeProvisioner {
  const core = {
    readNamespacedService: async () => ({
      spec: {
        ports: service.port === undefined ? [] : [{ port: service.port }],
        clusterIP: service.clusterIP,
      },
    }),
  };
  const discovery = {
    listNamespacedEndpointSlice: async () => ({
      items: [
        {
          endpoints: endpoints.map((endpoint) => ({
            addresses: endpoint.addresses,
            ...(endpoint.hostname === undefined ? {} : { hostname: endpoint.hostname }),
            conditions: { ready: endpoint.ready ?? true },
          })),
        },
      ],
    }),
  };
  const kubeConfig = {
    // The constructor asks for the core client first, then discovery.
    makeApiClient: (client: unknown) => (client === k8s.CoreV1Api ? core : discovery),
  } as unknown as k8s.KubeConfig;
  return new KubeProvisioner("sandbox-workloads", "sandbox-system", kubeConfig);
}

/**
 * A Service lookup that returns a different spec per requested name, so a
 * sharded read can be told apart from the shardless one.
 */
function stableProvisioner(
  services: Record<string, { port?: number; clusterIP?: string }>,
): KubeProvisioner {
  const requested: string[] = [];
  const core = {
    readNamespacedService: async ({ name }: { name: string }) => {
      requested.push(name);
      const service = services[name];
      if (!service) {
        const err = new Error(`services "${name}" not found`) as Error & { code?: number };
        err.code = 404;
        throw err;
      }
      return {
        spec: {
          ports: service.port === undefined ? [] : [{ port: service.port }],
          clusterIP: service.clusterIP,
        },
      };
    },
  };
  const kubeConfig = {
    makeApiClient: () => core,
  } as unknown as k8s.KubeConfig;
  return new KubeProvisioner("sandbox-workloads", "sandbox-system", kubeConfig);
}

describe("getStableServiceAddress", () => {
  it("returns the Service ClusterIP, not a Pod IP", async () => {
    const kube = stableProvisioner({
      relay: { port: 8443, clusterIP: "10.96.0.7" },
    });
    await expect(kube.getStableServiceAddress("relay")).resolves.toEqual({
      host: "10.96.0.7",
      port: 8443,
    });
  });

  it("reads the per-shard Service named after the pod ordinal", async () => {
    const kube = stableProvisioner({
      "relay-0": { port: 8443, clusterIP: "10.96.1.1" },
      "relay-1": { port: 8443, clusterIP: "10.96.1.2" },
    });
    await expect(kube.getStableServiceAddress("relay", 0, "relay")).resolves.toEqual({
      host: "10.96.1.1",
      port: 8443,
    });
    await expect(kube.getStableServiceAddress("relay", 1, "relay")).resolves.toEqual({
      host: "10.96.1.2",
      port: 8443,
    });
  });

  it("refuses a headless Service, which has no address a guest can dial", async () => {
    const kube = stableProvisioner({
      "relay-headless": { port: 8443, clusterIP: "None" },
    });
    await expect(kube.getStableServiceAddress("relay-headless")).resolves.toBeNull();
  });

  it("returns null for a missing Service or a Service with no ports", async () => {
    const kube = stableProvisioner({ relay: { clusterIP: "10.96.0.7" } });
    await expect(kube.getStableServiceAddress("relay")).resolves.toBeNull();
    await expect(kube.getStableServiceAddress("relay-3", 3, "relay")).resolves.toBeNull();
  });
});

describe("getServiceAddress", () => {
  it("returns the first ready endpoint address, not the ClusterIP", async () => {
    const kube = provisioner({ port: 8443, clusterIP: "10.96.0.1" }, [
      { addresses: ["10.1.0.5"], hostname: "relay-0", ready: false },
      { addresses: ["10.1.0.6"], hostname: "relay-1" },
    ]);

    await expect(kube.getServiceAddress("relay")).resolves.toEqual({ host: "10.1.0.6", port: 8443 });
  });

  it("falls back to the ClusterIP when no endpoint is ready", async () => {
    const kube = provisioner({ port: 8443, clusterIP: "10.96.0.1" }, [
      { addresses: ["10.1.0.5"], hostname: "relay-0", ready: false },
    ]);

    await expect(kube.getServiceAddress("relay")).resolves.toEqual({ host: "10.96.0.1", port: 8443 });
  });

  it("selects the endpoint whose hostname matches the shard", async () => {
    const kube = provisioner({ port: 8443, clusterIP: "10.96.0.1" }, [
      { addresses: ["10.1.0.5"], hostname: "relay-0" },
      { addresses: ["10.1.0.6"], hostname: "relay-1" },
      { addresses: ["10.1.0.7"], hostname: "relay-2" },
    ]);

    await expect(kube.getServiceAddress("relay", 1)).resolves.toEqual({ host: "10.1.0.6", port: 8443 });
    await expect(kube.getServiceAddress("relay", 2)).resolves.toEqual({ host: "10.1.0.7", port: 8443 });
  });

  it("returns null for a shard with no ready endpoint and no ClusterIP fallback", async () => {
    const kube = provisioner({ port: 8443, clusterIP: "10.96.0.1" }, [
      { addresses: ["10.1.0.5"], hostname: "relay-0" },
      { addresses: ["10.1.0.6"], hostname: "relay-1", ready: false },
    ]);

    // Shard 1 exists but is not ready, and shard 3 does not exist. Neither may
    // fall back to the ClusterIP or to another shard's pod.
    await expect(kube.getServiceAddress("relay", 1)).resolves.toBeNull();
    await expect(kube.getServiceAddress("relay", 3)).resolves.toBeNull();
  });

  it("does not match a hostname from a different service", async () => {
    const kube = provisioner({ port: 3128, clusterIP: "10.96.0.2" }, [
      { addresses: ["10.2.0.5"], hostname: "egress-proxy-0" },
    ]);

    await expect(kube.getServiceAddress("relay", 0)).resolves.toBeNull();
  });

  // Regression: a sharded lookup reads the headless Service, whose endpoints
  // are named after the StatefulSet pod (`relay-0`), not the Service
  // (`relay-headless-0`). The workload prefix is passed explicitly.
  it("matches the pod ordinal of the workload when the Service name differs", async () => {
    const kube = provisioner({ port: 8443 }, [
      { addresses: ["10.1.0.5"], hostname: "relay-0" },
      { addresses: ["10.1.0.6"], hostname: "relay-1" },
    ]);

    await expect(kube.getServiceAddress("relay-headless", 1, "relay")).resolves.toEqual({
      host: "10.1.0.6",
      port: 8443,
    });
    // Without the prefix the Service name is used, so nothing matches.
    await expect(kube.getServiceAddress("relay-headless", 1)).resolves.toBeNull();
  });
});
