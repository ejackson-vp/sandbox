/**
 * Provisioning concurrency cap: the persisted PROVISIONING count alone is
 * stale while concurrent workers are between admission and the state write.
 */
import { describe, expect, it, vi } from "vitest";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import { Provisioning } from "../../controller/src/provisioning.js";
import type { SessionRecord, Store } from "../../controller/src/store.js";
import type { WarmPool } from "../../controller/src/warm-pool.js";

function session(id: string, state: SessionRecord["state"] = "PAID"): SessionRecord {
  return {
    id,
    state,
    paidAt: Date.now(),
    timingsJson: null,
  } as unknown as SessionRecord;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness(limit: number, persisted: SessionRecord[] = []) {
  const cfg = loadControllerConfig({
    ADMIN_TOKEN: "p".repeat(24),
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DB_PATH: ":memory:",
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
    MAX_CONCURRENT_PROVISIONING: String(limit),
  });
  const gate = deferred();
  const mergeTimings = vi.fn();
  const requestTermination = vi.fn();
  const store = {
    listNonTerminal: () => persisted,
    mergeTimings,
    requestTermination,
  } as unknown as Store;
  let admissions = 0;
  const relay = {
    isReady: async () => {
      // Only sessions admitted past the cap reach the relay gate.
      admissions += 1;
      await gate.promise;
      return false;
    },
  } as unknown as RelayClient;
  const provisioning = new Provisioning(
    {
      cfg,
      store,
      provisioner: {} as Provisioner,
      relay,
      capacity: {} as never,
      snapshotter: {} as never,
      now: () => Date.now(),
      serviceAddress: async () => null,
    },
    {} as WarmPool,
  );
  return { provisioning, mergeTimings, gate, admissions: () => admissions };
}

describe("provisioning slot cap", () => {
  it("holds the second provision while the first is in flight", async () => {
    const { provisioning, mergeTimings, gate } = harness(1);

    const first = provisioning.provision(session("sbx_first"));
    // The first call is parked in relay.isReady and holds the only slot.
    await expect(
      Promise.race([
        provisioning.provision(session("sbx_second")),
        new Promise((_, reject) => setTimeout(() => reject(new Error("second provision did not defer")), 500)),
      ]),
    ).resolves.toBeUndefined();

    expect(mergeTimings).toHaveBeenCalledWith(
      "sbx_second",
      expect.objectContaining({ provisionQueueEnteredAt: expect.any(Number) }),
    );

    gate.resolve();
    await first;
  });

  it("counts a persisted session and a different in-flight session separately", async () => {
    // Regression: max(persisted, inFlight) saw max(1, 1) = 1 here and admitted
    // a third session even though two slots were occupied.
    const persisted = [session("sbx_persisted", "PROVISIONING")];
    const { provisioning, mergeTimings, gate, admissions } = harness(2, persisted);

    const inflight = provisioning.provision(session("sbx_inflight"));
    expect(admissions()).toBe(1);

    const third = provisioning.provision(session("sbx_third"));
    await expect(
      Promise.race([
        third,
        new Promise((_, reject) => setTimeout(() => reject(new Error("third provision did not defer")), 500)),
      ]),
    ).resolves.toBeUndefined();

    expect(mergeTimings).toHaveBeenCalledWith(
      "sbx_third",
      expect.objectContaining({ provisionQueueEnteredAt: expect.any(Number) }),
    );
    expect(admissions()).toBe(1);

    gate.resolve();
    await inflight;
  });

  it("admits queued work once a relay-gated slot is released", async () => {
    const persisted = [session("sbx_persisted", "PROVISIONING")];
    const { provisioning, mergeTimings, gate, admissions } = harness(3, persisted);

    // Occupancy is 2 (one persisted, one in flight), so a third fits.
    const inflight = provisioning.provision(session("sbx_inflight"));
    const third = provisioning.provision(session("sbx_third"));
    expect(admissions()).toBe(2);

    // Now occupancy is 3; a fourth must wait for a slot to free.
    await provisioning.provision(session("sbx_fourth"));
    expect(mergeTimings).toHaveBeenCalledWith(
      "sbx_fourth",
      expect.objectContaining({ provisionQueueEnteredAt: expect.any(Number) }),
    );
    expect(admissions()).toBe(2);

    // Relay-not-ready returns release both in-flight slots in `finally`, so
    // the retried fourth is admitted instead of queued.
    gate.resolve();
    await inflight;
    await third;

    mergeTimings.mockClear();
    await provisioning.provision(session("sbx_fourth"));
    expect(mergeTimings).not.toHaveBeenCalled();
    expect(admissions()).toBe(3);
  });
});
