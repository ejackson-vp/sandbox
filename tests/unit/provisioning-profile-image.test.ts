import { describe, expect, it, vi } from "vitest";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { SandboxPodSpec } from "../../controller/src/k8s-types.js";
import { guestEnvFor } from "../../controller/src/k8s-pod.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import { Provisioning } from "../../controller/src/provisioning.js";
import type { SessionRecord, Store } from "../../controller/src/store.js";
import type { WarmPoolManager } from "../../controller/src/warm-pool-manager.js";
import { config, digestBase, digestNode, digestPython } from "./helpers/warm-pool-fixtures.js";

function session(overrides: Partial<SessionRecord> = {}, runtime?: string): SessionRecord {
  return {
    id: "sbx_profile",
    state: "PAID",
    durationSeconds: 300,
    limits: {
      cpuMillis: 500,
      memoryMiB: 512,
      diskMiB: 256,
      maxOutputBytes: 1_048_576,
      maxFileBytes: 1_048_576,
      maxCommandSeconds: 300,
      maxProcesses: 64,
    },
    clientPublicKey: "client-key",
    clientNonce: "client-nonce",
    paidAt: Date.now(),
    timingsJson: null,
    ...(runtime === undefined ? {} : { runtime }),
    ...overrides,
  } as unknown as SessionRecord;
}

function harness() {
  const cfg = config();
  const createPod = vi.fn(async (spec: SandboxPodSpec) => ({ podName: `sbx-${spec.sessionId}` }));
  const store = {
    mergeTimings: vi.fn(),
    setRelayToken: vi.fn(),
    requestTermination: vi.fn(() => true),
  } as unknown as Store;
  const relay = {
    isReady: vi.fn(async () => true),
    registerCurrent: vi.fn(async () => ({ generation: "test", attempts: 1 })),
  } as unknown as RelayClient;
  const provisioner = { createPod } as unknown as Provisioner;
  const provisioning = new Provisioning(
    {
      cfg,
      store,
      provisioner,
      relay,
      capacity: {} as never,
      snapshotter: {} as never,
      now: () => Date.now(),
      serviceAddress: async (name: string) =>
        name === cfg.proxyServiceName
          ? { host: "10.0.0.9", port: 3128 }
          : { host: "10.0.0.1", port: 8443 },
    },
    {} as WarmPoolManager,
  );
  return { cfg, provisioning, createPod, store };
}

const relayAddr = { host: "10.0.0.1", port: 8443 };
const proxyAddr = { host: "10.0.0.9", port: 3128 };

describe("cold provisioning image selection", () => {
  it("boots the profile image the session asked for", async () => {
    const { provisioning, createPod } = harness();
    await provisioning.createPod(session({}, "python"), relayAddr, proxyAddr);
    expect(createPod).toHaveBeenCalledTimes(1);
    const spec = createPod.mock.calls[0]![0];
    expect(spec.image).toBe(`ghcr.io/example/guest@${digestPython}`);
    expect(spec.imageDigest).toBe(digestPython);
    expect(spec.runtimeProfile).toBe("python");
  });

  it("boots the base guest image when no profile is given", async () => {
    const { provisioning, createPod } = harness();
    await provisioning.createPod(session(), relayAddr, proxyAddr);
    const spec = createPod.mock.calls[0]![0];
    expect(spec.image).toBe(`ghcr.io/example/guest@${digestBase}`);
    expect(spec.imageDigest).toBe(digestBase);
    // Base has no manifest, so the env must not name one.
    expect(spec.runtimeProfile).toBeUndefined();
  });

  it("normalises a missing runtime to base rather than inventing a profile", async () => {
    const { provisioning, createPod } = harness();
    await provisioning.createPod(session({}, ""), relayAddr, proxyAddr);
    expect(createPod.mock.calls[0]![0].imageDigest).toBe(digestBase);
  });

  it("passes the profile to the guest environment", () => {
    const env = guestEnvFor(
      {
        executionMode: "dev",
        image: "img",
        imageDigest: digestPython,
        runtimeProfile: "python",
        runtimeClass: "x402-sandbox",
        proxyUrl: "http://proxy:3128",
        workspaceDir: "/workspace",
        guestToken: "token",
        proxyToken: "proxy-token",
        limits: session().limits,
      },
      "python3,node",
      [],
    );
    expect(env.find((entry) => entry.name === "RUNTIME_PROFILE")?.value).toBe("python");
  });

  it("omits the profile from the guest environment for base", () => {
    const env = guestEnvFor(
      {
        executionMode: "dev",
        image: "img",
        imageDigest: digestBase,
        runtimeClass: "x402-sandbox",
        proxyUrl: "http://proxy:3128",
        workspaceDir: "/workspace",
        guestToken: "token",
        proxyToken: "proxy-token",
        limits: session().limits,
      },
      "python3,node",
      [],
    );
    expect(env.find((entry) => entry.name === "RUNTIME_PROFILE")).toBeUndefined();
  });
});

describe("unknown runtime profiles fail closed", () => {
  it("terminates a paid session instead of running the wrong image", async () => {
    const { provisioning, createPod, store } = harness();
    await provisioning.provision(session({}, "ruby"));
    expect(createPod).toHaveBeenCalledTimes(0);
    expect(store.requestTermination).toHaveBeenCalledWith(
      "sbx_profile",
      "failure:runtime_profile_unavailable",
      expect.objectContaining({ code: "runtime_profile_unavailable" }),
    );
  });
});
