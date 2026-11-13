/**
 * The singleton guard has to fail on the change it exists to catch, or it is
 * just a second copy of the manifest. Each case writes a temporary deploy
 * directory with one deliberate edit and asserts the check rejects it.
 *
 * The relay half is no longer "exactly one replica": it is that the StatefulSet,
 * RELAY_REPLICAS and the per-shard Services agree, and that a rollout cannot put
 * two registries on one shard.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSingletons } from "../../scripts/check-singletons.mjs";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const CONTROLLER = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: controller
  namespace: sandbox-system
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels: {app: controller}
  template:
    spec:
      containers:
        - name: controller
          image: control:dev
`;

const CONFIG = `apiVersion: v1
kind: ConfigMap
metadata:
  name: control-config
  namespace: sandbox-system
data:
  # Two shards, matching 12-relay.yaml.
  RELAY_REPLICAS: "2"
  PROXY_REPLICAS: "1"
`;

const RELAY = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: relay
  namespace: sandbox-system
spec:
  replicas: 2
  serviceName: relay-headless
  podManagementPolicy: OrderedReady
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
  selector:
    matchLabels: {app: relay}
  template:
    spec:
      containers:
        - name: relay
          image: control:dev
`;

function shardService(shard: number, podName = `relay-${shard}`): string {
  return `apiVersion: v1
kind: Service
metadata:
  name: relay-${shard}
  namespace: sandbox-system
spec:
  selector:
    statefulset.kubernetes.io/pod-name: ${podName}
  ports:
    - name: guest
      port: 8443
      targetPort: 8443
`;
}

const SERVICES = `${shardService(0)}---\n${shardService(1)}`;

function deployDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "x402-singletons-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

function check(
  controller = CONTROLLER,
  relay = RELAY,
  services = SERVICES,
  config = CONFIG,
) {
  return checkSingletons(
    deployDir({
      "03-config.yaml": config,
      "11-controller.yaml": controller,
      "12-relay.yaml": `${relay}---\n${services}`,
    }),
  );
}

describe("singleton manifest guard", () => {
  it("accepts the committed shape", () => {
    expect(check()).toEqual([]);
  });

  it("rejects a second controller replica", () => {
    const problems = check(CONTROLLER.replace("replicas: 1", "replicas: 2"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/controller replicas is 2, must be 1/);
  });

  it("rejects a rolling controller update that surges", () => {
    const problems = check(
      CONTROLLER.replace(
        "  strategy:\n    type: Recreate",
        "  strategy:\n    type: RollingUpdate\n    rollingUpdate:\n      maxSurge: 1",
      ),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/maxSurge 1, must be 0/);
  });

  it("rejects a rolling controller update with the default surge", () => {
    const problems = check(CONTROLLER.replace("    type: Recreate", "    type: RollingUpdate"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/maxSurge unset, must be 0/);
  });

  it("accepts a rolling controller update with maxSurge 0", () => {
    const problems = check(
      CONTROLLER.replace(
        "  strategy:\n    type: Recreate",
        "  strategy:\n    type: RollingUpdate\n    rollingUpdate:\n      maxSurge: 0\n      maxUnavailable: 1",
      ),
    );
    expect(problems).toEqual([]);
  });

  it("rejects a relay scale that disagrees with RELAY_REPLICAS", () => {
    const problems = check(CONTROLLER, RELAY.replace("replicas: 2", "replicas: 1"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/relay replicas is 1 but .*RELAY_REPLICAS 2/);
  });

  it("rejects RELAY_REPLICAS that disagrees with the StatefulSet", () => {
    const problems = check(CONTROLLER, RELAY, SERVICES, CONFIG.replace('"2"', '"4"'));
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/relay replicas is 2 but .*RELAY_REPLICAS 4/);
    expect(problems[1]).toMatch(/no Service named relay-2/);
    expect(problems[2]).toMatch(/no Service named relay-3/);
  });

  it("rejects a parallel relay pod management policy", () => {
    const problems = check(CONTROLLER, RELAY.replace("OrderedReady", "Parallel"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/podManagementPolicy is Parallel/);
  });

  it("rejects a relay rollout that surges", () => {
    const problems = check(CONTROLLER, RELAY.replace("maxSurge: 0", "maxSurge: 1"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/relay updateStrategy maxSurge is 1, must be 0/);
  });

  it("rejects a relay rollout that leaves the surge unset", () => {
    const problems = check(
      CONTROLLER,
      RELAY.replace("    rollingUpdate:\n      maxSurge: 0\n", ""),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/relay updateStrategy maxSurge is unset, must be 0/);
  });

  it("rejects a missing per-shard Service", () => {
    const problems = check(CONTROLLER, RELAY, shardService(0));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no Service named relay-1 for RELAY_REPLICAS 2/);
  });

  it("rejects a per-shard Service selecting another shard", () => {
    const problems = check(
      CONTROLLER,
      RELAY,
      `${shardService(0)}---\n${shardService(1, "relay-0")}`,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Service relay-1 selects pod-name relay-0, expected relay-1/);
  });

  it("rejects a missing RELAY_REPLICAS", () => {
    const problems = check(
      CONTROLLER,
      RELAY,
      SERVICES,
      `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: control-config\ndata:\n  PROXY_REPLICAS: "1"\n`,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no RELAY_REPLICAS in ConfigMap control-config/);
  });

  it("fails closed when a workload is missing", () => {
    const problems = checkSingletons(deployDir({ "11-controller.yaml": CONTROLLER }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no StatefulSet named relay/);
  });

  it("fails closed when replicas cannot be read", () => {
    // A restructured manifest the reader does not understand must not pass.
    const problems = check(CONTROLLER.replace("  replicas: 1", "  replicas: {count: 1}"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/controller replicas is/);
  });
});
