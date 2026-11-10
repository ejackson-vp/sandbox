import { describe, expect, it, vi } from "vitest";
import { loadControllerConfig, type ControllerConfig } from "../../controller/src/config.js";
import { dataPlaneShard } from "../../controller/src/data-plane-shard.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import { Provisioning } from "../../controller/src/provisioning.js";
import type { SessionRecord, Store } from "../../controller/src/store.js";
import type { WarmPool } from "../../controller/src/warm-pool.js";

const TOKENS = {
  ADMIN_TOKEN: "a".repeat(24),
  RELAY_ADMIN_TOKEN: "r".repeat(24),
  WAKE_TOKEN: "w".repeat(24),
  PROXY_TOKEN_SECRET: "p".repeat(24),
};

function config(env: Record<string, string> = {}): ControllerConfig {
  return loadControllerConfig({
    ...TOKENS,
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DB_PATH: ":memory:",
    ...env,
  });
}

function session(id: string): SessionRecord {
  return {
    id,
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
  } as unknown as SessionRecord;
}

interface CreatedPod {
  relayUrl: string;
  relayPort: number;
  proxyUrl: string;
  guestToken: string;
  proxyToken: string;
}

function harness(
  cfg: ControllerConfig,
  serviceAddress = vi.fn(async (_name: string, _shard?: number) => null),
) {
  const createPod = vi.fn(async (_spec: CreatedPod) => ({ podName: "sbx-pod" }));
  const requestTermination = vi.fn();
  const store = {
    mergeTimings: vi.fn(),
    setRelayToken: vi.fn(),
    setProvisioning: vi.fn(() => true),
    requestTermination,
  } as unknown as Store;
  const relay = {
    isReady: async () => true,
    registerCurrent: vi.fn(async () => ({ generation: "g", attempts: 1 })),
  } as unknown as RelayClient;
  const provisioner = {
    createPod,
    listSandboxPods: vi.fn(async () => []),
  } as unknown as Provisioner;
  const provisioning = new Provisioning(
    {
      cfg,
      store,
      provisioner,
      relay,
      capacity: {
        getReservation: () => ({ nodeId: "disabled" }),
        updatePod: vi.fn(),
      } as never,
      snapshotter: {} as never,
      now: () => Date.now(),
      serviceAddress,
    },
    { tryClaim: async () => false } as unknown as WarmPool,
  );
  return { provisioning, createPod, serviceAddress, requestTermination };
}

/**
 * Two ids, one per shard, found deterministically so the test does not depend
 * on a lucky literal.
 */
function idsForTwoShards(): [string, string] {
  let zero: string | undefined;
  let one: string | undefined;
  for (let i = 0; i < 1000 && (zero === undefined || one === undefined); i += 1) {
    const id = `sbx_shard_probe_${i}`;
    const shard = dataPlaneShard(id, 2);
    if (shard === 0 && zero === undefined) zero = id;
    if (shard === 1 && one === undefined) one = id;
  }
  if (!zero || !one) throw new Error("could not find ids for both shards");
  return [zero, one];
}

describe("provisioning data-plane placement", () => {
  it("keeps the ClusterIP endpoints byte-identical with one replica", async () => {
    const cfg = config();
    const serviceAddress = vi.fn(async (name: string) =>
      name === cfg.relayServiceName
        ? { host: "10.0.0.1", port: cfg.relayPort }
        : { host: "10.0.0.9", port: cfg.proxyPort },
    );
    const { provisioning, createPod } = harness(cfg, serviceAddress);

    await provisioning.createPod(
      session("sbx_single"),
      { host: "10.0.0.1", port: cfg.relayPort },
      { host: "10.0.0.9", port: cfg.proxyPort },
    );

    const spec = createPod.mock.calls[0]![0];
    expect(spec.relayUrl).toBe(`ws://10.0.0.1:${cfg.relayPort}/guest?session=sbx_single`);
    expect(serviceAddress).toHaveBeenCalledWith(cfg.relayServiceName);
    // createPod re-resolves only the relay (its pod IP changes on replacement);
    // the proxy address comes from the caller unchanged.
    expect(spec.proxyUrl).toBe(`http://10.0.0.9:${cfg.proxyPort}`);
    // No shard claim is minted when there is nothing to shard.
    expect(spec.guestToken).not.toContain(".");
    expect(spec.proxyToken.startsWith("v1.")).toBe(true);
  });

  it("hands the guest shard endpoint IPs, never a hostname, with two replicas", async () => {
    const cfg = config({ RELAY_REPLICAS: "2", PROXY_REPLICAS: "2" });
    const serviceAddress = vi.fn(async (name: string, shard?: number) => {
      const ordinal = (shard ?? 0) + 1;
      return name === cfg.relayHeadlessService
        ? { host: `10.1.1.${ordinal}`, port: cfg.relayPort }
        : { host: `10.1.2.${ordinal}`, port: cfg.proxyPort };
    });
    const { provisioning, createPod } = harness(cfg, serviceAddress);
    const [zero, one] = idsForTwoShards();

    await provisioning.provision(session(zero));
    await provisioning.provision(session(one));

    const first = createPod.mock.calls[0]![0];
    const second = createPod.mock.calls[1]![0];
    const firstShard = dataPlaneShard(zero, 2);
    const secondShard = dataPlaneShard(one, 2);
    expect(firstShard).not.toBe(secondShard);

    expect(first.relayUrl).toBe(
      `ws://10.1.1.${firstShard + 1}:${cfg.relayPort}/guest?session=${encodeURIComponent(zero)}`,
    );
    expect(first.proxyUrl).toBe(`http://10.1.2.${firstShard + 1}:${cfg.proxyPort}`);
    expect(second.relayUrl).toBe(
      `ws://10.1.1.${secondShard + 1}:${cfg.relayPort}/guest?session=${encodeURIComponent(one)}`,
    );
    expect(second.proxyUrl).toBe(`http://10.1.2.${secondShard + 1}:${cfg.proxyPort}`);

    // Different shards must be handed different endpoints.
    expect(first.relayUrl).not.toBe(second.relayUrl);
    expect(first.proxyUrl).not.toBe(second.proxyUrl);

    // A guest runs with `dnsPolicy: None` and no DNS egress: a headless Service
    // name would be unresolvable, so neither URL may contain one.
    expect(first.relayUrl).not.toContain("relay-headless");
    expect(first.proxyUrl).not.toContain("egress-proxy-headless");
    expect(serviceAddress).toHaveBeenCalledWith(
      cfg.relayHeadlessService,
      firstShard,
      cfg.relayServiceName,
    );
    expect(serviceAddress).toHaveBeenCalledWith(
      cfg.proxyHeadlessService,
      firstShard,
      cfg.proxyServiceName,
    );
  });

  it("defers, without creating a pod, when the session's shard has no ready endpoint", async () => {
    const cfg = config({ RELAY_REPLICAS: "2", PROXY_REPLICAS: "2" });
    const { provisioning, createPod, requestTermination } = harness(cfg);

    await provisioning.provision(session("sbx_no_shard_endpoint"));

    // No pod is created: a hostname in the pod spec could never be dialled.
    // The session is not terminated either: a rolling restart of that replica
    // must not fail a paid session. The provisioning timeout refunds if the
    // shard never comes back.
    expect(createPod).not.toHaveBeenCalled();
    expect(requestTermination).not.toHaveBeenCalled();
  });

  it("mints shard claims into both credentials when replicas > 1", async () => {
    const cfg = config({ RELAY_REPLICAS: "2", PROXY_REPLICAS: "2" });
    const { provisioning, createPod } = harness(cfg);
    const [zero] = idsForTwoShards();
    const shard = dataPlaneShard(zero, 2);

    await provisioning.createPod(
      session(zero),
      { host: "10.0.0.1", port: cfg.relayPort },
      { host: "10.0.0.9", port: cfg.proxyPort },
    );

    const spec = createPod.mock.calls[0]![0];
    expect(spec.guestToken.endsWith(`.${shard}`)).toBe(true);
    expect(spec.proxyToken.startsWith("v2.")).toBe(true);
    expect(spec.proxyToken.split(".")[2]).toBe(String(shard));
  });
});

describe("data-plane placement config", () => {
  it("rejects a relay host template without {shard} when replicas > 1", () => {
    expect(() => config({ RELAY_REPLICAS: "2", RELAY_HOST_TEMPLATE: "relay" })).toThrow(
      /RELAY_HOST_TEMPLATE must contain \{shard\}/,
    );
  });

  it("rejects a proxy host template without {shard} when replicas > 1", () => {
    expect(() => config({ PROXY_REPLICAS: "3", PROXY_HOST_TEMPLATE: "egress-proxy" })).toThrow(
      /PROXY_HOST_TEMPLATE must contain \{shard\}/,
    );
  });

  it("accepts a shardless template while there is one replica", () => {
    expect(() => config({ RELAY_HOST_TEMPLATE: "relay" })).not.toThrow();
  });

  it("defaults to one replica with the StatefulSet pod templates", () => {
    const cfg = config();
    expect(cfg.relayReplicas).toBe(1);
    expect(cfg.proxyReplicas).toBe(1);
    expect(cfg.relayHostTemplate).toBe("relay-{shard}.relay-headless");
    expect(cfg.proxyHostTemplate).toBe("egress-proxy-{shard}.egress-proxy-headless");
    expect(cfg.shardIndex).toBeUndefined();
  });

  it("reads the pod ordinal from a StatefulSet pod name", () => {
    expect(config({ RELAY_REPLICAS: "4", ROLE: "relay", SHARD_INDEX: "relay-2" }).shardIndex).toBe(2);
    expect(config({ PROXY_REPLICAS: "4", ROLE: "proxy", SHARD_INDEX: "3" }).shardIndex).toBe(3);
  });

  it("rejects an ordinal outside the replicas it will serve", () => {
    expect(() => config({ ROLE: "relay", RELAY_REPLICAS: "2", SHARD_INDEX: "relay-2" })).toThrow(
      /outside the 2-replica range/,
    );
  });

  it("requires an ordinal when a role will run more than one replica", () => {
    expect(() => config({ ROLE: "relay", RELAY_REPLICAS: "2" })).toThrow(/SHARD_INDEX is required/);
    expect(() => config({ ROLE: "proxy", PROXY_REPLICAS: "2" })).toThrow(/SHARD_INDEX is required/);
  });

  it("does not require an ordinal for a role that is not itself a replica", () => {
    // The controller routes by shard but serves no ordinal of its own.
    const cfg = config({ ROLE: "controller", RELAY_REPLICAS: "2", PROXY_REPLICAS: "2" });
    expect(cfg.shardIndex).toBeUndefined();
  });
});
