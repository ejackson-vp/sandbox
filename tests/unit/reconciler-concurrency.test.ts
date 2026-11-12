/**
 * Reconciler scheduling: bounded per-phase concurrency and queue metrics.
 *
 * These use a fake store/provisioner so the test controls exactly when a
 * "slow provisioner" returns. The lifecycle modules are stubbed at the
 * `Provisioning` seam, not at `tick`, so the real dispatcher and the real
 * in-flight guard are exercised.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
// The reconciler imports the built workspace package, so the test must read the
// same instance to assert on exported metrics. CI builds before running tests.
import { metrics } from "@x402s/shared/runtime";
import { loadControllerConfig } from "../../controller/src/config.js";
import { Reconciler } from "../../controller/src/reconciler.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type { SessionRecord, Store } from "../../controller/src/store.js";
import { testDatabaseUrl } from "../helpers/test-store.js";

const ADMIN = "unit-admin-token-0123456789";

function config(concurrency: number) {
  return loadControllerConfig({
    ADMIN_TOKEN: ADMIN,
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DATABASE_URL: testDatabaseUrl(),
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
    RECONCILE_CONCURRENCY: String(concurrency),
  });
}

function session(id: string, state: SessionRecord["state"] = "PAID"): SessionRecord {
  return {
    id,
    state,
    podName: null,
    destroyRequested: 0,
    paidAt: Date.now(),
    leaseExpiresAt: null,
    readyAt: null,
  } as unknown as SessionRecord;
}

function harness(sessions: SessionRecord[], terminal: SessionRecord[] = [], concurrency = 8) {
  const clearPod = vi.fn();
  // The tick selects by due time; this fake treats every listed session as
  // due and re-arms through the same store surface as the real Store. The
  // assertions below are unchanged: they exercise dispatch/concurrency, not
  // the SQL schedule.
  const store = {
    listDue: (_now: number, limit: number) => sessions.slice(0, limit),
    listNonTerminal: () => sessions,
    listTerminalWithPod: () => terminal,
    getSession: (id: string) => [...sessions, ...terminal].find((s) => s.id === id) ?? null,
    rearmDue: vi.fn(() => true),
    countDue: () => sessions.length,
    countLiveByState: () =>
      sessions.reduce<Record<string, number>>((counts, s) => {
        counts[s.state] = (counts[s.state] ?? 0) + 1;
        return counts;
      }, {}),
    clearPod,
    requestTermination: vi.fn(() => true),
  } as unknown as Store;
  const deletePod = vi.fn(async () => undefined);
  const provisioner = { deletePod } as unknown as Provisioner;
  const relay = { isReady: async () => true } as unknown as RelayClient;
  const reconciler = new Reconciler({ cfg: config(concurrency), store, provisioner, relay });
  const provisioning = (
    reconciler as unknown as {
      provisioning: { provision: (s: SessionRecord) => Promise<void> };
    }
  ).provisioning;
  return { reconciler, deletePod, clearPod, provisioning };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met before the timeout");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconciler phase concurrency", () => {
  it("does not let one slow provisioner session delay another", async () => {
    const slow = session("sbx_slow");
    const fast = session("sbx_fast");
    const { reconciler, provisioning } = harness([slow, fast]);
    const gate = deferred();
    const started: string[] = [];
    const finished: string[] = [];
    provisioning.provision = async (s) => {
      started.push(s.id);
      if (s.id === slow.id) await gate.promise;
      finished.push(s.id);
    };

    const tick = reconciler.tick();
    await waitFor(() => finished.includes(fast.id));

    // The fast session completed while the slow one is still parked in the
    // provisioner, even though the slow one was listed first.
    expect(started).toContain(slow.id);
    expect(finished).not.toContain(slow.id);

    gate.resolve();
    await tick;
    expect(finished).toEqual([fast.id, slow.id]);
  });

  it("caps concurrent reconciles per phase", async () => {
    const sessions = Array.from({ length: 20 }, (_, i) => session(`sbx_${i}`));
    const { reconciler, provisioning } = harness(sessions, [], 8);
    const gate = deferred();
    let started = 0;
    let active = 0;
    let peak = 0;
    provisioning.provision = async () => {
      started += 1;
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
    };

    const tick = reconciler.tick();
    await waitFor(() => started >= 8);
    // Give the scheduler room to start a ninth if the bound were wrong.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(started).toBe(8);

    gate.resolve();
    await tick;
    expect(started).toBe(20);
    expect(peak).toBe(8);
  });

  it("keeps terminal-pod cleanup out of the readiness pass", async () => {
    const live = session("sbx_live");
    const dead = { ...session("sbx_dead", "DESTROYED"), podName: "pod-dead" } as SessionRecord;
    const { reconciler, deletePod, clearPod, provisioning } = harness([live], [dead]);
    const gate = deferred();
    let started = false;
    provisioning.provision = async () => {
      started = true;
      await gate.promise;
    };

    const tick = reconciler.tick();
    await waitFor(() => started);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Readiness is still parked, so cleanup must not have started.
    expect(deletePod).not.toHaveBeenCalled();
    expect(clearPod).not.toHaveBeenCalled();

    gate.resolve();
    await tick;
    expect(deletePod).toHaveBeenCalledWith("pod-dead", 0);
    expect(clearPod).toHaveBeenCalledWith(dead.id);
  });

  it("never reconciles a session that is already in flight", async () => {
    const slow = session("sbx_slow");
    const { reconciler, provisioning } = harness([slow]);
    const gate = deferred();
    let started = 0;
    provisioning.provision = async () => {
      started += 1;
      await gate.promise;
    };

    const tick = reconciler.tick();
    await waitFor(() => started === 1);

    // Simulate a second pass overlapping the first (the guard a wake-driven
    // pass or a future per-session queue would rely on).
    const rerun = vi.fn(async () => undefined);
    const phase = (reconciler as unknown as {
      reconcilePhase: (
        phase: "readiness",
        sessions: SessionRecord[],
        run: (s: SessionRecord) => Promise<void>,
      ) => Promise<void>;
    }).reconcilePhase.bind(reconciler);
    await phase("readiness", [slow], rerun);

    expect(rerun).not.toHaveBeenCalled();
    expect(started).toBe(1);

    gate.resolve();
    await tick;
  });

  it("exports bounded queue depth and wait metrics without session ids", async () => {
    const { reconciler, provisioning } = harness([session("sbx_metric")]);
    provisioning.provision = async () => undefined;
    await reconciler.tick();

    // The registry caches rendered text for 500 ms; wait it out so this
    // assertion cannot read a snapshot taken before this tick.
    await new Promise((resolve) => setTimeout(resolve, 520));
    const text = metrics.render();
    expect(text).toContain('sandbox_reconcile_queue_depth{phase="readiness"}');
    expect(text).toContain('sandbox_reconcile_in_flight{phase="readiness"}');
    expect(text).toContain("sandbox_reconcile_queue_wait_seconds_count");
    expect(text).toContain('phase="cleanup"');
    expect(text).not.toContain("sbx_metric");
  });
});
