/**
 * The singleton guard has to fail on the change it exists to catch, or it is
 * just a second copy of the manifest. Each case writes a temporary deploy
 * directory with one deliberate edit and asserts the check rejects it.
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

const RELAY = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: relay
  namespace: sandbox-system
spec:
  replicas: 1
  serviceName: relay-headless
  podManagementPolicy: OrderedReady
  updateStrategy:
    type: RollingUpdate
  selector:
    matchLabels: {app: relay}
  template:
    spec:
      containers:
        - name: relay
          image: control:dev
`;

function deployDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "x402-singletons-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

function check(controller = CONTROLLER, relay = RELAY) {
  return checkSingletons(deployDir({ "11-controller.yaml": controller, "12-relay.yaml": relay }));
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

  it("rejects a second relay replica", () => {
    const problems = check(CONTROLLER, RELAY.replace("replicas: 1", "replicas: 2"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/relay replicas is 2, must be 1/);
  });

  it("rejects a parallel relay pod management policy", () => {
    const problems = check(CONTROLLER, RELAY.replace("OrderedReady", "Parallel"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/podManagementPolicy is Parallel/);
  });

  it("rejects a relay rollout that surges", () => {
    const problems = check(
      CONTROLLER,
      RELAY.replace(
        "  updateStrategy:\n    type: RollingUpdate",
        "  updateStrategy:\n    type: RollingUpdate\n    rollingUpdate:\n      maxSurge: 1",
      ),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/relay updateStrategy maxSurge is 1/);
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
