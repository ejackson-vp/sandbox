/**
 * The reconciler is where wall-clock readings turn into deadline decisions, so
 * it is the place a clock step has to be visible. The clock guard is unit
 * tested on its own; this checks the wiring, including that a step names the
 * sessions whose immutable deadline it moved.
 */
import { describe, expect, it, vi } from "vitest";
import { log } from "@x402s/shared/runtime";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import { Reconciler } from "../../controller/src/reconciler.js";
import type { ReconcilerStore } from "../../controller/src/store/ports.js";

function config() {
  return loadControllerConfig({
    ADMIN_TOKEN: "unit-admin-token-0123456789",
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DB_PATH: ":memory:",
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
  });
}

/** A store with no due work, so a pass only exercises the clock. */
function storeWithSessions(sessions: Array<{ id: string; leaseExpiresAt: number | null }>): ReconcilerStore {
  return {
    listDue: () => [],
    listTerminalWithPod: () => [],
    countLiveByState: () => ({}),
    countDue: () => 0,
    listNonTerminal: () => sessions,
  } as unknown as ReconcilerStore;
}

function reconciler(store: ReconcilerStore, now: () => number) {
  return new Reconciler({
    cfg: config(),
    store,
    provisioner: {} as Provisioner,
    relay: {} as RelayClient,
    now,
  });
}

describe("reconciler clock skew", () => {
  it("logs a forward step with the old and new readings and the sessions it moved", async () => {
    let wall = 1_700_000_000_000;
    const leases = [
      { id: "sbx_inside", leaseExpiresAt: wall + 30_000 },
      { id: "sbx_after", leaseExpiresAt: wall + 7_200_000 },
      { id: "sbx_suspended", leaseExpiresAt: null },
    ];
    const subject = reconciler(storeWithSessions(leases), () => wall);
    const warn = vi.spyOn(log, "warn");
    try {
      await subject.tick();

      // An hour forward: every deadline between the two readings is crossed.
      wall += 3_600_000;
      await subject.tick();

      const line = warn.mock.calls.find((call) => call[0] === "clock_skew_detected");
      expect(line).toBeDefined();
      const detail = line![1] as Record<string, unknown>;
      expect(detail.from).toBe(new Date(1_700_000_000_000).toISOString());
      expect(detail.to).toBe(new Date(1_700_003_600_000).toISOString());
      expect(detail.direction).toBe("forward");
      // Only the session whose deadline falls inside the jumped window is
      // affected; a null deadline (suspended) is not.
      expect(detail.affectedSessions).toBe(1);
      expect(detail.affectedSessionIds).toEqual(["sbx_inside"]);
    } finally {
      warn.mockRestore();
      subject.stop();
    }
  });

  it("logs a backward step as backward", async () => {
    let wall = 1_700_000_000_000;
    const subject = reconciler(storeWithSessions([]), () => wall);
    const warn = vi.spyOn(log, "warn");
    try {
      await subject.tick();
      wall -= 120_000;
      await subject.tick();

      const line = warn.mock.calls.find((call) => call[0] === "clock_skew_detected");
      expect(line).toBeDefined();
      const detail = line![1] as Record<string, unknown>;
      expect(detail.direction).toBe("backward");
      expect(detail.deltaMs).toBeLessThan(0);
    } finally {
      warn.mockRestore();
      subject.stop();
    }
  });

  it("says nothing when the clock and the process agree", async () => {
    let wall = 1_700_000_000_000;
    const subject = reconciler(storeWithSessions([]), () => wall);
    const warn = vi.spyOn(log, "warn");
    try {
      await subject.tick();
      wall += 250;
      await subject.tick();
      wall += 250;
      await subject.tick();

      expect(warn.mock.calls.filter((call) => call[0] === "clock_skew_detected")).toEqual([]);
    } finally {
      warn.mockRestore();
      subject.stop();
    }
  });
});
