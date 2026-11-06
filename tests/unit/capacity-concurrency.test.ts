import { afterEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../controller/src/store.js";
import type { CapacitySnapshot, SandboxResourceRequest } from "../../controller/src/capacity/types.js";

const MiB = 1024 * 1024;
const WORKER = join(process.cwd(), "tests/unit/helpers/reservation-worker.ts");
const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function snapshot(): CapacitySnapshot {
  return {
    nodes: [{
      id: "node-a",
      allocatable: { cpuMillicores: 1_000, memoryBytes: 2_048 * MiB, storageBytes: 10_240 * MiB },
      platformOverhead: { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 },
      labels: { "x402.io/sandbox-pool": "true" },
      taints: [],
      ready: true,
      schedulable: true,
    }],
    reservations: [],
    now: Date.now(),
  };
}

const request: SandboxResourceRequest = {
  baseline: { cpuMillicores: 1_000, memoryBytes: 512 * MiB, storageBytes: 1_024 * MiB },
  peak: { cpuMillicores: 1_000, memoryBytes: 512 * MiB, storageBytes: 1_024 * MiB },
};

function waitFor(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker timeout waiting for ${type}`)), 20_000);
    const handler = (message: Record<string, unknown>) => {
      if (message.type !== type) return;
      clearTimeout(timer);
      child.off("message", handler);
      resolve(message);
    };
    child.on("message", handler);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}`));
    });
  });
}

describe("real SQLite reservation concurrency", () => {
  it("allows exactly one winner across separate processes and connections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-capacity-concurrent-"));
    dirs.push(dir);
    const dbPath = join(dir, "controller.db");
    const store = new Store(dbPath);
    store.close();

    const workers = Array.from({ length: 8 }, (_, i) => {
      const child = fork(WORKER, [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      children.push(child);
      child.send({
        type: "init",
        dbPath,
        paymentKey: `${i}`.padStart(64, "0"),
        specHash: "f".repeat(64),
        snapshot: snapshot(),
        request,
      });
      return child;
    });

    await Promise.all(workers.map((child) => waitFor(child, "ready")));
    const results = workers.map((child) => waitFor(child, "result"));
    for (const child of workers) child.send({ type: "go" });
    const settled = await Promise.all(results);
    expect(settled.filter((r) => r.admitted === true)).toHaveLength(1);
    expect(settled.filter((r) => r.admitted === false)).toHaveLength(7);
  }, 30_000);
});
