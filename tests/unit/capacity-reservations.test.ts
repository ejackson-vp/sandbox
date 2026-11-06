import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../controller/src/store.js";
import type { CapacitySnapshot, SandboxResourceRequest } from "../../controller/src/capacity/types.js";

const MiB = 1024 * 1024;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "x402-capacity-"));
  dirs.push(dir);
  return new Store(join(dir, "controller.db"));
}

function snapshot(now = Date.now()): CapacitySnapshot {
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
    now,
  };
}

function request(): SandboxResourceRequest {
  return {
    baseline: { cpuMillicores: 1_000, memoryBytes: 512 * MiB, storageBytes: 1_024 * MiB },
    peak: { cpuMillicores: 1_000, memoryBytes: 512 * MiB, storageBytes: 1_024 * MiB },
  };
}

describe("durable capacity reservations", () => {
  it("admits one of many competing requests for the same finite capacity", () => {
    const store = freshStore();
    try {
      const decisions = Array.from({ length: 10 }, (_, i) =>
        store.reservations.admit(snapshot(), request(), {
          paymentKey: `${i}`.padStart(64, "0"),
          specHash: "a".repeat(64),
          ttlMs: 60_000,
        }),
      );
      expect(decisions.filter((d) => d.admitted)).toHaveLength(1);
      expect(decisions.filter((d) => !d.admitted)).toHaveLength(9);
    } finally {
      store.close();
    }
  });

  it("returns the same hold for an idempotent payment retry", () => {
    const store = freshStore();
    try {
      const paymentKey = "b".repeat(64);
      const first = store.reservations.admit(snapshot(), request(), {
        paymentKey,
        specHash: "b".repeat(64),
        ttlMs: 60_000,
      });
      const second = store.reservations.admit(snapshot(), request(), {
        paymentKey,
        specHash: "b".repeat(64),
        ttlMs: 60_000,
      });
      expect(first.admitted).toBe(true);
      expect(second.admitted).toBe(true);
      if (first.admitted && second.admitted) {
        expect(second.reservation.id).toBe(first.reservation.id);
        expect(second.reused).toBe(true);
      }
    } finally {
      store.close();
    }
  });

  it("releases compute on suspend, lets B take it, and rejects A's resume until B is gone", () => {
    const store = freshStore();
    try {
      const a = store.reservations.admit(snapshot(), request(), {
        sessionId: "sbx_a",
        specHash: "a".repeat(64),
        state: "ALLOCATED",
      });
      expect(a.admitted).toBe(true);

      const bBlocked = store.reservations.admit(snapshot(), request(), {
        sessionId: "sbx_b",
        specHash: "b".repeat(64),
        state: "ALLOCATED",
      });
      expect(bBlocked.admitted).toBe(false);

      expect(store.reservations.suspendSession("sbx_a")).toBe(true);
      const b = store.reservations.admit(snapshot(), request(), {
        sessionId: "sbx_b",
        specHash: "b".repeat(64),
        state: "ALLOCATED",
      });
      expect(b.admitted).toBe(true);

      const resumeBlocked = store.reservations.resume(snapshot(), request(), "sbx_a");
      expect(resumeBlocked.admitted).toBe(false);
      expect(store.reservations.getBySession("sbx_a")?.state).toBe("SUSPENDED");

      expect(store.reservations.releaseSession("sbx_b")).toBe(true);
      const resumed = store.reservations.resume(snapshot(), request(), "sbx_a");
      expect(resumed.admitted).toBe(true);
      expect(store.reservations.getBySession("sbx_a")?.state).toBe("ALLOCATED");
    } finally {
      store.close();
    }
  });

  it("converts a payment hold into a session reservation without releasing capacity", () => {
    const store = freshStore();
    try {
      const paymentKey = "d".repeat(64);
      const hold = store.reservations.admit(snapshot(), request(), {
        paymentKey,
        specHash: "d".repeat(64),
        ttlMs: 60_000,
      });
      expect(hold.admitted).toBe(true);

      const attached = store.reservations.attachToSession(
        snapshot(),
        request(),
        paymentKey,
        "sbx_attached",
        "d".repeat(64),
      );
      expect(attached.admitted).toBe(true);
      expect(store.reservations.getBySession("sbx_attached")?.state).toBe("ALLOCATED");
      expect(store.reservations.getByPayment(paymentKey)?.state).toBe("ALLOCATED");

      const blocked = store.reservations.admit(snapshot(), request(), {
        sessionId: "sbx_other",
        state: "ALLOCATED",
      });
      expect(blocked.admitted).toBe(false);
    } finally {
      store.close();
    }
  });

  it("rebinds a reservation when a crash left an undurable session id", () => {
    const store = freshStore();
    try {
      const paymentKey = "e".repeat(64);
      store.reservations.admit(snapshot(), request(), {
        paymentKey,
        specHash: "e".repeat(64),
        ttlMs: 60_000,
      });
      const first = store.reservations.attachToSession(
        snapshot(),
        request(),
        paymentKey,
        "sbx_never_inserted",
        "e".repeat(64),
      );
      expect(first.admitted).toBe(true);
      const rebound = store.reservations.attachToSession(
        snapshot(),
        request(),
        paymentKey,
        "sbx_after_restart",
        "e".repeat(64),
      );
      expect(rebound.admitted).toBe(true);
      expect(store.reservations.getBySession("sbx_after_restart")?.state).toBe("ALLOCATED");
      expect(store.reservations.getBySession("sbx_never_inserted")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("keeps capacity reserved in RELEASING until the Pod is confirmed gone", () => {
    const store = freshStore();
    try {
      expect(store.reservations.admit(snapshot(), request(), {
        sessionId: "sbx_release",
        state: "ALLOCATED",
      }).admitted).toBe(true);
      expect(store.reservations.beginRelease("sbx_release", "pod-1")).toBe(true);
      expect(store.reservations.getBySession("sbx_release")?.state).toBe("RELEASING");

      const blocked = store.reservations.admit(snapshot(), request(), {
        sessionId: "sbx_blocked",
        state: "ALLOCATED",
      });
      expect(blocked.admitted).toBe(false);

      expect(store.reservations.confirmRelease("sbx_release")).toBe(true);
      expect(store.reservations.getBySession("sbx_release")?.state).toBe("RELEASED");
    } finally {
      store.close();
    }
  });

  it("expires provisional holds without leaking capacity", () => {
    const store = freshStore();
    try {
      const now = Date.now();
      const hold = store.reservations.admit(snapshot(now), request(), {
        paymentKey: "c".repeat(64),
        specHash: "c".repeat(64),
        ttlMs: 5_000,
      });
      expect(hold.admitted).toBe(true);
      expect(store.reservations.reapExpiredHolds(now + 6_000)).toBeGreaterThanOrEqual(1);
      expect(store.reservations.getByPayment("c".repeat(64))?.state).toBe("RELEASED");

      const rehold = store.reservations.admit(snapshot(now + 6_000), request(), {
        paymentKey: "c".repeat(64),
        specHash: "c".repeat(64),
        ttlMs: 5_000,
      });
      expect(rehold.admitted).toBe(true);
      expect(store.reservations.getByPayment("c".repeat(64))?.state).toBe("HELD");

      const after = store.reservations.admit(snapshot(now + 6_000), request(), {
        sessionId: "sbx_after",
        state: "ALLOCATED",
      });
      expect(after.admitted).toBe(false); // rehold still owns the capacity
    } finally {
      store.close();
    }
  });
});
