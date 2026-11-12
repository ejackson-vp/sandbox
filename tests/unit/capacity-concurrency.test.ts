/**
 * Capacity admission under real concurrency.
 *
 * Eight admissions are issued before any is awaited, so they land on eight pool
 * connections and the transaction-scoped advisory lock in the adapter, not on
 * one serialised client. Exactly one may win: that is the property, not the
 * number of processes that asked.
 */
import { describe, expect, it } from "vitest";
import type { CapacitySnapshot, SandboxResourceRequest } from "../../controller/src/capacity/types.js";
import { freshStore } from "../helpers/test-store.js";

const MiB = 1024 * 1024;

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
    accounting: "baseline",
  };
}

const request: SandboxResourceRequest = {
  baseline: { cpuMillicores: 1_000, memoryBytes: 512 * MiB, storageBytes: 1_024 * MiB },
  peak: { cpuMillicores: 1_000, memoryBytes: 512 * MiB, storageBytes: 1_024 * MiB },
};

describe("real Postgres reservation concurrency", () => {
  it("allows exactly one winner across separate connections", async () => {
    const store = await freshStore({ max: 10 });
    const decisions = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.reservations.admit(snapshot(), request, {
          paymentKey: `${i}`.padStart(64, "0"),
          specHash: "f".repeat(64),
          ttlMs: 60_000,
        }),
      ),
    );
    const errors = decisions.filter((d) => !d.admitted);
    expect(errors).toHaveLength(7);
    expect(decisions.filter((d) => d.admitted)).toHaveLength(1);
    expect(decisions.filter((d) => !d.admitted)).toHaveLength(7);
  }, 30_000);
});
