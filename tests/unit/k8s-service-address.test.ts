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
});
