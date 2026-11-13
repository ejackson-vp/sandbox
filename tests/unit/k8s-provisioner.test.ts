/**
 * The Kubernetes provisioner, over the wire.
 *
 * The PodSpec this controller sends is the security boundary: a missing
 * RuntimeClass, an unmirrored limit or a lost session label is a cluster-level
 * bug that a unit test on the returned pod name would never see. So these tests
 * run a real HTTP server that speaks enough of the Kubernetes API to accept the
 * request, and assert the JSON that arrived.
 *
 * `tests/helpers/fake-apiserver.ts` answers only the verbs used here and 501s
 * the rest, so a new call added to the provisioner fails loudly rather than
 * passing against a permissive double.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_TOKEN, FakeApiServer } from "../helpers/fake-apiserver.js";
import {
  NAMESPACE,
  container,
  createdPod,
  envOf,
  provisioner,
  sandboxSpec,
  warmSpec,
} from "./helpers/k8s-fixtures.js";

const servers: FakeApiServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function fakeApi(): Promise<FakeApiServer> {
  const api = await FakeApiServer.start();
  servers.push(api);
  return api;
}

describe("createPod", () => {
  it("sends the mandatory RuntimeClass, the session labels and the purchased limits", async () => {
    const api = await fakeApi();
    const spec = sandboxSpec();

    await expect(provisioner(api).createPod(spec)).resolves.toEqual({
      podName: "sbx-0123456789abcdef",
    });

    const pod = createdPod(api);
    expect(pod.metadata.name).toBe("sbx-0123456789abcdef");
    expect(pod.metadata.namespace).toBe(NAMESPACE);
    expect(pod.metadata.labels).toEqual({
      "app.kubernetes.io/name": "x402-sandbox",
      "x402.io/session": "sbx_0123456789abcdef",
      "x402.io/pool": "sandbox",
    });
    expect(pod.metadata.annotations).toEqual({
      "x402.io/mode": "kata",
      "x402.io/lease-seconds": "600",
      "x402.io/cpu-millis": "1500",
      "x402.io/memory-mib": "2048",
      "x402.io/disk-mib": "1024",
      "x402.io/warning": "NON-CONFIDENTIAL: simulated attestation only",
    });

    // Mandatory, not a default: without it the guest runs on the shared kernel
    // and every isolation claim in the docs is false.
    expect(pod.spec.runtimeClassName).toBe("kata-fc");
    // Lease, plus the longest command, plus the provisioning slack the
    // reconciler relies on before Kubernetes kills the pod out from under it.
    expect(pod.spec.activeDeadlineSeconds).toBe(600 + 120 + 300);

    const guest = container(pod, "guest");
    expect(guest.image).toBe("registry.internal/x402-guest:dev");
    expect(guest.resources?.limits).toEqual({
      cpu: "1500m",
      memory: "2048Mi",
      "ephemeral-storage": "1088Mi",
    });
    // Requests are a quarter of the purchase: the scheduler reserves a shape
    // the pod is allowed to burst past, not the whole node.
    expect(guest.resources?.requests).toEqual({
      cpu: "375m",
      memory: "512Mi",
      "ephemeral-storage": "16Mi",
    });

    expect(envOf(pod, "guest")).toMatchObject({
      SESSION_ID: "sbx_0123456789abcdef",
      RELAY_URL: "wss://relay.internal:8443",
      CLIENT_PUBLIC_KEY: "client-public-key",
      CLIENT_NONCE: "client-nonce",
      LEASE_SECONDS: "600",
      EXECUTION_MODE: "kata",
      RUNTIME_CLASS: "kata-fc",
      WORKSPACE_DIR: "/workspace",
    });
    expect(container(pod, "bootstrap").name).toBe("bootstrap");
    // The guest token and the attestation key are read by the init container
    // and moved to a mode-0400 file, so the customer-facing container's
    // environment never holds them.
    expect(envOf(pod, "bootstrap")).toHaveProperty("GUEST_TOKEN", "guest-token");
    expect(envOf(pod, "guest")).not.toHaveProperty("GUEST_TOKEN");
  });

  it("mounts the workspace claim, pins the node and keeps the reservation override", async () => {
    const api = await fakeApi();
    const spec = sandboxSpec({
      workspacePvc: "x402-ws-0123456789abcdef",
      nodeName: "pool-a",
      resume: true,
      baselineCpuMillis: 100,
      baselineMemoryMiB: 256,
    });

    await provisioner(api).createPod(spec);

    const pod = createdPod(api);
    const workspace = pod.spec.volumes.find((volume) => volume.name === "workspace");
    expect(workspace?.persistentVolumeClaim).toEqual({
      claimName: "x402-ws-0123456789abcdef",
    });
    // A resumed session keeps its volume: an emptyDir here would silently
    // discard everything the customer checkpointed.
    expect(workspace?.emptyDir).toBeUndefined();

    expect(
      pod.spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution
        ?.nodeSelectorTerms?.[0]?.matchFields?.[0],
    ).toEqual({ key: "metadata.name", operator: "In", values: ["pool-a"] });
    expect(envOf(pod, "guest")).toMatchObject({ RESUME: "1" });
    expect(container(pod, "guest").resources?.requests).toMatchObject({
      cpu: "100m",
      memory: "256Mi",
    });
  });
});

describe("createWarmPod", () => {
  it("labels the pod by pool and warm id, and never with a session", async () => {
    const api = await fakeApi();

    await expect(provisioner(api).createWarmPod(warmSpec())).resolves.toEqual({
      podName: "warm-warm0a1b2c3d",
    });

    const pod = createdPod(api);
    expect(pod.metadata.labels).toEqual({
      "app.kubernetes.io/name": "x402-sandbox",
      "x402.io/pool": "warm",
      "x402.io/warm-id": "warm0a1b2c3d",
      "x402.io/runtime": "base",
    });
    // A warm pod has no customer yet, so a session label here would make the
    // reaper treat unclaimed capacity as a live session.
    expect(pod.metadata.labels).not.toHaveProperty("x402.io/session");
    expect(pod.metadata.annotations).toEqual({
      "x402.io/mode": "kata",
      "x402.io/warm-pool": "true",
      "x402.io/warm-identity": "identity-hash",
      "x402.io/image-digest": "sha256:guest",
      "x402.io/runtime": "base",
      "x402.io/cpu-millis": "1500",
      "x402.io/memory-mib": "2048",
      "x402.io/disk-mib": "1024",
      "x402.io/warning": "NON-CONFIDENTIAL: warm pool, simulated attestation only",
    });
    // The pool TTL plus the hour a claimed pod may still run under a lease.
    expect(pod.spec.activeDeadlineSeconds).toBe(60 + 3600);
    expect(envOf(pod, "guest")).toMatchObject({
      WARM_MODE: "true",
      POOL_ID: "pool-a",
      WARM_TTL_SECONDS: "60",
      GUEST_TOOLS: "python3,node",
    });
  });
});

describe("applyPod", () => {
  it("treats a 409 as a pod that already exists, so a retried create is a no-op", async () => {
    const api = await fakeApi();
    const kube = provisioner(api);

    await kube.createPod(sandboxSpec());
    const second = await kube.createPod(sandboxSpec());

    expect(second).toEqual({ podName: "sbx-0123456789abcdef" });
    // Two requests, one pod: the fake only answers 409 when the name is taken,
    // and the provisioner swallowed that, which is what makes the retry safe.
    expect(api.calls("POST", /\/pods$/)).toHaveLength(2);
  });

  it("propagates any other create failure: only AlreadyExists is idempotent", async () => {
    for (const status of [404, 500]) {
      const api = await fakeApi();
      api.failNext("POST", /\/pods$/, status);

      await expect(provisioner(api).createPod(sandboxSpec())).rejects.toMatchObject({
        code: status,
      });
    }
  });
});

describe("deletePod and suspendPod", () => {
  it("sends the requested grace period", async () => {
    const api = await fakeApi();
    const kube = provisioner(api);
    await kube.createPod(sandboxSpec());

    await kube.deletePod("sbx-0123456789abcdef", 30);

    const [request] = api.calls("DELETE", /\/pods\/sbx-0123456789abcdef$/);
    expect(request?.query).toEqual({ gracePeriodSeconds: "30" });
  });

  it("treats a missing pod as already deleted and rethrows anything else", async () => {
    const api = await fakeApi();
    const kube = provisioner(api);

    await expect(kube.deletePod("sbx-gone")).resolves.toBeUndefined();
    expect(api.calls("DELETE", /\/pods\/sbx-gone$/)[0]?.query).toEqual({
      gracePeriodSeconds: "0",
    });

    api.failNext("DELETE", /\/pods\/sbx-/, 500);
    await expect(kube.deletePod("sbx-0123456789abcdef")).rejects.toMatchObject({ code: 500 });
  });

  it("suspends by deleting with zero grace and waiting for the pod to go", async () => {
    const api = await fakeApi();
    const kube = provisioner(api);
    await kube.createPod(sandboxSpec());

    await expect(kube.suspendPod("sbx-0123456789abcdef")).resolves.toBeUndefined();

    // The resume path reuses the pod name, so returning before the apiserver
    // has actually dropped the object would race the recreate.
    expect(api.calls("DELETE")[0]?.query).toEqual({ gracePeriodSeconds: "0" });
    expect(api.calls("GET", /\/pods\/sbx-0123456789abcdef$/).length).toBeGreaterThan(0);
    await expect(kube.getPod("sbx-0123456789abcdef")).resolves.toBeNull();
  });
});

describe("getPod", () => {
  it("maps the phase, the scheduling and start times, the image and deletion", async () => {
    const api = await fakeApi();
    api.seedPod({
      metadata: {
        name: "sbx-a",
        creationTimestamp: "2026-01-02T03:04:05Z",
        deletionTimestamp: "2026-01-02T03:09:00Z",
      },
      status: {
        phase: "Running",
        conditions: [
          { type: "Initialized", status: "True", lastTransitionTime: "2026-01-02T03:04:04Z" },
          { type: "PodScheduled", status: "True", lastTransitionTime: "2026-01-02T03:04:06Z" },
        ],
        containerStatuses: [
          {
            name: "guest",
            imageID: "sha256:guest",
            state: { running: { startedAt: "2026-01-02T03:04:08Z" } },
          },
        ],
      },
    });

    await expect(provisioner(api).getPod("sbx-a")).resolves.toEqual({
      phase: "Running",
      deleted: true,
      imageID: "sha256:guest",
      createdAt: Date.parse("2026-01-02T03:04:05Z"),
      scheduledAt: Date.parse("2026-01-02T03:04:06Z"),
      startedAt: Date.parse("2026-01-02T03:04:08Z"),
    });
  });

  it("falls back to the first container's start time and to an Unknown phase", async () => {
    const api = await fakeApi();
    api.seedPod({
      metadata: { name: "sbx-b" },
      status: {
        containerStatuses: [
          {
            name: "loopback",
            imageID: "sha256:first",
            state: { running: { startedAt: "2026-01-02T03:04:08Z" } },
          },
        ],
      },
    });

    await expect(provisioner(api).getPod("sbx-b")).resolves.toEqual({
      phase: "Unknown",
      deleted: false,
      imageID: "sha256:first",
      startedAt: Date.parse("2026-01-02T03:04:08Z"),
    });
  });

  it("returns null for a gone pod and rethrows any other read failure", async () => {
    const api = await fakeApi();
    const kube = provisioner(api);

    await expect(kube.getPod("sbx-gone")).resolves.toBeNull();

    api.failNext("GET", /\/pods\/sbx-gone$/, 403);
    await expect(kube.getPod("sbx-gone")).rejects.toMatchObject({ code: 403 });
  });
});

describe("patchPodLabels", () => {
  it("sends a JSON patch, with a remove operation for a null label", async () => {
    const api = await fakeApi();
    api.seedPod({
      metadata: {
        name: "warm-warm0a1b2c3d",
        labels: { "app.kubernetes.io/name": "x402-sandbox", "x402.io/pool": "warm" },
      },
    });

    await provisioner(api).patchPodLabels("warm-warm0a1b2c3d", {
      "x402.io/session": "sbx_0123456789abcdef",
      "x402.io/pool": null,
    });

    const [request] = api.calls("PATCH", /\/pods\/warm-warm0a1b2c3d$/);
    // A merge patch with a null would also remove the label, but the generated
    // client picks this content type, so the operations are the contract.
    expect(request?.headers["content-type"]).toBe("application/json-patch+json");
    expect(request?.body).toEqual([
      // `/` is the JSON-pointer separator, so a label key that contains one
      // (`x402.io/session`) has to be escaped or the apiserver reads it as a
      // path into `.io`.
      { op: "add", path: "/metadata/labels/x402.io~1session", value: "sbx_0123456789abcdef" },
      { op: "remove", path: "/metadata/labels/x402.io~1pool" },
    ]);
  });
});

describe("workspace PVCs", () => {
  it("creates the claim with the session labels and a size that leaves room for the disk", async () => {
    const api = await fakeApi();

    await expect(provisioner(api).createWorkspacePvc("sbx_0123456789abcdef", 1024)).resolves.toBe(
      "x402-ws-0123456789abcdef",
    );

    const [request] = api.calls("POST", /\/persistentvolumeclaims$/);
    expect(request?.body).toEqual({
      metadata: {
        name: "x402-ws-0123456789abcdef",
        namespace: NAMESPACE,
        labels: { "x402.io/session": "sbx_0123456789abcdef", "x402.io/pool": "workspace" },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        // The suite does not set WORKSPACE_STORAGE_CLASS; `standard` is the
        // documented default for a cluster without an explicit class.
        storageClassName: "standard",
        resources: { requests: { storage: "1088Mi" } },
      },
    });
  });

  it("treats a 409 as the same claim and rethrows any other create failure", async () => {
    const api = await fakeApi();
    const kube = provisioner(api);

    await kube.createWorkspacePvc("sbx_0123456789abcdef", 128);
    await expect(kube.createWorkspacePvc("sbx_0123456789abcdef", 128)).resolves.toBe(
      "x402-ws-0123456789abcdef",
    );

    api.failNext("POST", /\/persistentvolumeclaims$/, 500);
    await expect(kube.createWorkspacePvc("sbx_other", 128)).rejects.toMatchObject({ code: 500 });
  });

  it("deletes a claim, swallowing a missing one", async () => {
    const api = await fakeApi();
    const kube = provisioner(api);
    const name = await kube.createWorkspacePvc("sbx_0123456789abcdef", 128);

    await expect(kube.deleteWorkspacePvc(name)).resolves.toBeUndefined();
    await expect(kube.deleteWorkspacePvc(name)).resolves.toBeUndefined();

    api.failNext("DELETE", /\/persistentvolumeclaims\//, 500);
    await expect(kube.deleteWorkspacePvc(name)).rejects.toMatchObject({ code: 500 });
  });

  it("reports whether a claim still exists", async () => {
    const api = await fakeApi();
    api.seedPvc({ metadata: { name: "x402-ws-kept" } });
    const kube = provisioner(api);

    await expect(kube.workspacePvcExists("x402-ws-kept")).resolves.toBe(true);
    await expect(kube.workspacePvcExists("x402-ws-gone")).resolves.toBe(false);

    api.failNext("GET", /\/persistentvolumeclaims\//, 403);
    await expect(kube.workspacePvcExists("x402-ws-kept")).rejects.toMatchObject({ code: 403 });
  });

  it("lists only workspace claims and survives a missing label or timestamp", async () => {
    const api = await fakeApi();
    api.seedPvc({
      metadata: {
        name: "x402-ws-owned",
        labels: { "x402.io/session": "sbx_0123456789abcdef", "x402.io/pool": "workspace" },
        creationTimestamp: "2026-01-02T03:04:05Z",
        deletionTimestamp: "2026-01-02T04:04:05Z",
      },
    });
    api.seedPvc({
      metadata: { name: "x402-ws-bare", labels: { "x402.io/pool": "workspace" } },
    });
    // A different pool must not reach the retention sweep: deleting this one
    // would take a live session's checkpoint with it.
    api.seedPvc({
      metadata: { name: "x402-ws-other", labels: { "x402.io/pool": "checkpoint" } },
    });

    await expect(provisioner(api).listWorkspacePvcs()).resolves.toEqual([
      {
        name: "x402-ws-owned",
        sessionId: "sbx_0123456789abcdef",
        createdAt: Date.parse("2026-01-02T03:04:05Z"),
        deleting: true,
      },
      { name: "x402-ws-bare", sessionId: "", createdAt: 0, deleting: false },
    ]);
    expect(api.calls("GET", /\/persistentvolumeclaims$/)[0]?.query.labelSelector).toBe(
      "x402.io/pool=workspace",
    );
  });
});

describe("listSandboxPods", () => {
  it("returns the sandbox pool only, with empty strings for a missing label", async () => {
    const api = await fakeApi();
    api.seedPod({
      metadata: {
        name: "sbx-a",
        labels: {
          "app.kubernetes.io/name": "x402-sandbox",
          "x402.io/pool": "sandbox",
          "x402.io/session": "sbx_a",
        },
        creationTimestamp: "2026-01-02T03:04:05Z",
      },
      status: { phase: "Running" },
    });
    api.seedPod({
      metadata: {
        name: "sbx-orphan",
        labels: { "app.kubernetes.io/name": "x402-sandbox", "x402.io/pool": "sandbox" },
      },
    });
    api.seedPod({
      metadata: {
        name: "warm-a",
        labels: { "app.kubernetes.io/name": "x402-sandbox", "x402.io/pool": "warm" },
      },
      status: { phase: "Pending" },
    });

    await expect(provisioner(api).listSandboxPods()).resolves.toEqual([
      {
        name: "sbx-a",
        sessionId: "sbx_a",
        createdAt: Date.parse("2026-01-02T03:04:05Z"),
        phase: "Running",
      },
      { name: "sbx-orphan", sessionId: "", createdAt: 0, phase: "Unknown" },
    ]);
    expect(api.calls("GET", /\/pods$/)[0]?.query.labelSelector).toBe(
      "app.kubernetes.io/name=x402-sandbox,x402.io/pool=sandbox",
    );
  });
});

describe("listWarmPods", () => {
  it("prefers the runtime annotation over the label and omits an absent node", async () => {
    const api = await fakeApi();
    api.seedPod({
      metadata: {
        name: "warm-a",
        labels: {
          "app.kubernetes.io/name": "x402-sandbox",
          "x402.io/pool": "warm",
          "x402.io/warm-id": "warm_a",
          "x402.io/runtime": "stale-label",
        },
        annotations: {
          "x402.io/runtime": "python",
          "x402.io/warm-identity": "identity-a",
          "x402.io/image-digest": "sha256:a",
        },
        creationTimestamp: "2026-01-02T03:04:05Z",
      },
      spec: { nodeName: "pool-a" },
      status: { phase: "Running" },
    });
    // A pod from before the annotation existed carries only the label.
    api.seedPod({
      metadata: {
        name: "warm-b",
        labels: {
          "app.kubernetes.io/name": "x402-sandbox",
          "x402.io/pool": "warm",
          "x402.io/warm-id": "warm_b",
          "x402.io/runtime": "python",
        },
      },
      status: { phase: "Pending" },
    });

    await expect(provisioner(api).listWarmPods()).resolves.toEqual([
      {
        name: "warm-a",
        warmId: "warm_a",
        poolId: "warm_warm_a",
        createdAt: Date.parse("2026-01-02T03:04:05Z"),
        phase: "Running",
        runtime: "python",
        identity: "identity-a",
        imageDigest: "sha256:a",
        nodeName: "pool-a",
      },
      {
        name: "warm-b",
        warmId: "warm_b",
        poolId: "warm_warm_b",
        createdAt: 0,
        phase: "Pending",
        runtime: "python",
        identity: "",
        imageDigest: "",
      },
    ]);
    expect(api.calls("GET", /\/pods$/)[0]?.query.labelSelector).toBe(
      "app.kubernetes.io/name=x402-sandbox,x402.io/pool=warm",
    );
  });
});

describe("healthCheck", () => {
  it("reads one pod from the workload namespace", async () => {
    const api = await fakeApi();

    await expect(provisioner(api).healthCheck()).resolves.toBeUndefined();

    const [request] = api.calls("GET", /\/pods$/);
    expect(request?.path).toBe(`/api/v1/namespaces/${NAMESPACE}/pods`);
    // One pod, not a full list: the probe runs on a schedule and the answer is
    // "can this identity read the namespace", not "what is in it".
    expect(request?.query).toEqual({ limit: "1" });
    expect(request?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it("throws when the identity may not read the namespace", async () => {
    const api = await fakeApi();
    api.failNext("GET", /\/pods$/, 403);

    await expect(provisioner(api).healthCheck()).rejects.toMatchObject({ code: 403 });
  });
});

describe("fake apiserver", () => {
  it("fails a verb it does not implement with a 501 that names it", async () => {
    const api = await fakeApi();
    // Service lookup is not wired into the fixture. A permissive double would
    // return an empty Service and this would pass; the 501 is what turns a new
    // product-code call into a failing test instead of a silent no-op.
    await expect(provisioner(api).getStableServiceAddress("relay")).rejects.toMatchObject({
      code: 501,
    });
  });
});

describe("nodeAvailable", () => {
  it("is true only for a ready, uncordoned node", async () => {
    const api = await fakeApi();
    api.seedNode({
      metadata: { name: "pool-ready" },
      spec: {},
      status: { conditions: [{ type: "Ready", status: "True" }] },
    });
    api.seedNode({
      metadata: { name: "pool-cordoned" },
      spec: { unschedulable: true },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    });
    api.seedNode({
      metadata: { name: "pool-unready" },
      spec: {},
      status: { conditions: [{ type: "Ready", status: "False" }] },
    });
    const kube = provisioner(api);

    await expect(kube.nodeAvailable("pool-ready")).resolves.toBe(true);
    await expect(kube.nodeAvailable("pool-cordoned")).resolves.toBe(false);
    await expect(kube.nodeAvailable("pool-unready")).resolves.toBe(false);
    await expect(kube.nodeAvailable("pool-gone")).resolves.toBe(false);
  });

  it("rethrows a read failure that is not a missing node", async () => {
    const api = await fakeApi();
    api.failNext("GET", /\/api\/v1\/nodes\/pool-a$/, 403);

    await expect(provisioner(api).nodeAvailable("pool-a")).rejects.toMatchObject({ code: 403 });
  });
});
