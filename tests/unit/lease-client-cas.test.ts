/**
 * The compare-and-swap the election rests on.
 *
 * Every other lease test injects a fake `LeaseClient`, so the one line that
 * actually sends `metadata.resourceVersion` to Kubernetes had no test. Drop it
 * from the request body and renew, takeover and release all become blind
 * overwrites while every existing test stays green.
 *
 * This file mocks `CoordinationV1Api`, the same client `KubeLeaseClient` builds
 * in production, and asserts the body of each write. A replace built on a read
 * with no version is refused before it reaches the API server.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const kube = vi.hoisted(() => ({
  read: vi.fn(),
  create: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@kubernetes/client-node", () => {
  class KubeConfig {
    loadFromDefault(): void {}
    makeApiClient(): unknown {
      return {
        readNamespacedLease: kube.read,
        createNamespacedLease: kube.create,
        replaceNamespacedLease: kube.replace,
      };
    }
  }
  class CoordinationV1Api {}
  return { KubeConfig, CoordinationV1Api };
});

import {
  makeLeaseLeadership,
  type LeaseLeadershipOverrides,
} from "../../controller/src/leadership-lease.js";
import type { ControllerConfig } from "../../controller/src/config.js";

const NAMESPACE = "sandbox-system";
const NAME = "controller-leader";

function notFound(): Error {
  return Object.assign(new Error("leases.coordination.k8s.io not found"), { code: 404 });
}

function configFor(identity: string): ControllerConfig {
  return {
    controlNamespace: NAMESPACE,
    leaderLeaseName: NAME,
    leaderIdentity: identity,
  } as ControllerConfig;
}

function leaseObject(holder: string, resourceVersion: string, transitions = 0) {
  return {
    apiVersion: "coordination.k8s.io/v1",
    kind: "Lease",
    metadata: { name: NAME, namespace: NAMESPACE, resourceVersion },
    spec: {
      holderIdentity: holder,
      leaseDurationSeconds: 10,
      // MicroTime: exactly six fractional digits.
      acquireTime: "2026-01-01T00:00:00.000000Z",
      renewTime: "2026-01-01T00:00:00.000000Z",
      leaseTransitions: transitions,
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("KubeLeaseClient compare-and-swap", () => {
  it("creates without a version and renews with the one it read", async () => {
    kube.read.mockRejectedValueOnce(notFound());
    kube.create.mockResolvedValueOnce(leaseObject("controller-a", "1"));
    const lease = makeLeaseLeadership(configFor("controller-a"));
    await lease.start();

    const created = kube.create.mock.calls[0]![0];
    expect(created.namespace).toBe(NAMESPACE);
    expect(created.body.metadata.name).toBe(NAME);
    expect(created.body.metadata).not.toHaveProperty("resourceVersion");
    expect(created.body.spec.holderIdentity).toBe("controller-a");

    kube.read.mockResolvedValueOnce(leaseObject("controller-a", "7"));
    kube.replace.mockResolvedValueOnce(leaseObject("controller-a", "8"));
    await lease.tick();

    const renewed = kube.replace.mock.calls.at(-1)![0];
    expect(renewed.name).toBe(NAME);
    expect(renewed.namespace).toBe(NAMESPACE);
    // The fence: the write is built on the record the read returned.
    expect(renewed.body.metadata.resourceVersion).toBe("7");
    expect(renewed.body.spec.holderIdentity).toBe("controller-a");

    kube.read.mockResolvedValueOnce(leaseObject("controller-a", "8"));
    kube.replace.mockResolvedValueOnce(leaseObject("", "9"));
    await lease.stop();
  });

  it("releases with the version it read", async () => {
    kube.read.mockRejectedValueOnce(notFound());
    kube.create.mockResolvedValueOnce(leaseObject("controller-a", "1"));
    const lease = makeLeaseLeadership(configFor("controller-a"));
    await lease.start();

    kube.read.mockResolvedValueOnce(leaseObject("controller-a", "11"));
    kube.replace.mockResolvedValueOnce(leaseObject("", "12"));
    await lease.stop();

    const released = kube.replace.mock.calls.at(-1)![0];
    expect(released.body.metadata.resourceVersion).toBe("11");
    expect(released.body.spec.holderIdentity).toBe("");
  });

  it("takes over with the version it observed", async () => {
    const time = { wall: 1_000_000, mono: 5_000 };
    const options: LeaseLeadershipOverrides = {
      now: () => time.wall,
      monotonic: () => time.mono,
      callTimeoutMs: 500,
    };
    const lease = makeLeaseLeadership(configFor("controller-a"), options);

    // First sighting: another holder, not yet stalled. No write.
    kube.read.mockResolvedValueOnce(leaseObject("controller-b", "9", 1));
    await lease.start();
    expect(lease.isLeader()).toBe(false);
    expect(kube.replace).not.toHaveBeenCalled();

    // One full duration of the same record: the takeover is allowed, and it is
    // built on the version this replica actually saw.
    time.mono += 10_000;
    time.wall += 10_000;
    kube.read.mockResolvedValueOnce(leaseObject("controller-b", "9", 1));
    kube.replace.mockResolvedValueOnce(leaseObject("controller-a", "10", 2));
    await lease.tick();

    expect(lease.isLeader()).toBe(true);
    const takeover = kube.replace.mock.calls.at(-1)![0];
    expect(takeover.body.metadata.resourceVersion).toBe("9");
    expect(takeover.body.spec.holderIdentity).toBe("controller-a");
    expect(takeover.body.spec.leaseTransitions).toBe(2);

    kube.read.mockResolvedValueOnce(leaseObject("controller-b", "10", 2));
    await lease.stop();
  });

  it("refuses to replace a record it read without a version", async () => {
    kube.read.mockRejectedValueOnce(notFound());
    kube.create.mockResolvedValueOnce(leaseObject("controller-a", "1"));
    const lease = makeLeaseLeadership(configFor("controller-a"));
    await lease.start();
    kube.replace.mockClear();

    // A read with no resourceVersion is the shape that would become an
    // unconditional overwrite. It must not reach the API server.
    kube.read.mockResolvedValueOnce({
      apiVersion: "coordination.k8s.io/v1",
      kind: "Lease",
      metadata: { name: NAME, namespace: NAMESPACE },
      spec: {
        holderIdentity: "controller-a",
        leaseDurationSeconds: 10,
        leaseTransitions: 0,
      },
    });
    await lease.tick();

    expect(kube.replace).not.toHaveBeenCalled();
    // The failed renewal does not quietly drop the role; the deadline does.
    expect(lease.isLeader()).toBe(true);

    kube.read.mockResolvedValueOnce(leaseObject("controller-b", "2"));
    await lease.stop();
  });
});
