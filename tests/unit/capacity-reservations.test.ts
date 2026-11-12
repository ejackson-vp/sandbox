import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../controller/src/store.js";
import { availableOnNode } from "../../controller/src/capacity/placement.js";
import { holdsCompute, type CapacitySnapshot, type SandboxResourceRequest } from "../../controller/src/capacity/types.js";

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
    accounting: "baseline",
  };
}

function request(): SandboxResourceRequest {
  return {
    baseline: { cpuMillicores: 1_000, memoryBytes: 512 * MiB, storageBytes: 1_024 * MiB },
    peak: { cpuMillicores: 1_000, memoryBytes: 512 * MiB, storageBytes: 1_024 * MiB },
  };
}

describe("durable capacity reservations", () => {
  it("admits one of many competing requests for the same finite capacity", async () => {
    const store = freshStore();
    try {
      // All ten are issued before any of them is awaited: the adapter is the
      // only thing that can arbitrate, exactly as it would under a network
      // client where they arrive on separate connections.
      const decisions = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.reservations.admit(snapshot(), request(), {
            paymentKey: `${i}`.padStart(64, "0"),
            specHash: "a".repeat(64),
            ttlMs: 60_000,
          }),
        ),
      );
      expect(decisions.filter((d) => d.admitted)).toHaveLength(1);
      expect(decisions.filter((d) => !d.admitted)).toHaveLength(9);
    } finally {
      store.close();
    }
  });

  it("returns the same hold for an idempotent payment retry", async () => {
    const store = freshStore();
    try {
      const paymentKey = "b".repeat(64);
      const first = await store.reservations.admit(snapshot(), request(), {
        paymentKey,
        specHash: "b".repeat(64),
        ttlMs: 60_000,
      });
      const second = await store.reservations.admit(snapshot(), request(), {
        paymentKey,
        specHash: "b".repeat(64),
        ttlMs: 60_000,
      });
      expect(first.admitted).toBe(true);
      expect(second.admitted).toBe(true);
      if (first.admitted && second.admitted) {
        expect(second.reservation.id).toBe(first.reservation.id);
      }
    } finally {
      store.close();
    }
  });

  it("releases compute on suspend, lets B take it, and rejects A's resume until B is gone", async () => {
    const store = freshStore();
    try {
      const a = await store.reservations.admit(snapshot(), request(), {
        sessionId: "sbx_a",
        specHash: "a".repeat(64),
        state: "ALLOCATED",
      });
      expect(a.admitted).toBe(true);

      const bBlocked = await store.reservations.admit(snapshot(), request(), {
        sessionId: "sbx_b",
        specHash: "b".repeat(64),
        state: "ALLOCATED",
      });
      expect(bBlocked.admitted).toBe(false);

      expect(await store.reservations.suspendSession("sbx_a")).toBe(true);
      const b = await store.reservations.admit(snapshot(), request(), {
        sessionId: "sbx_b",
        specHash: "b".repeat(64),
        state: "ALLOCATED",
      });
      expect(b.admitted).toBe(true);

      const resumeBlocked = await store.reservations.resume(snapshot(), request(), "sbx_a");
      expect(resumeBlocked.admitted).toBe(false);
      expect((await store.reservations.getBySession("sbx_a"))?.state).toBe("SUSPENDED");

      expect(await store.reservations.releaseSession("sbx_b")).toBe(true);
      const resumed = await store.reservations.resume(snapshot(), request(), "sbx_a");
      expect(resumed.admitted).toBe(true);
      expect((await store.reservations.getBySession("sbx_a"))?.state).toBe("ALLOCATED");
    } finally {
      store.close();
    }
  });

  it("reasserts an admitted resume after a concurrent re-suspend", async () => {
    const store = freshStore();
    try {
      const a = await store.reservations.admit(snapshot(), request(), {
        sessionId: "sbx_a",
        specHash: "a".repeat(64),
        state: "ALLOCATED",
      });
      expect(a.admitted).toBe(true);
      expect(await store.reservations.suspendSession("sbx_a")).toBe(true);
      expect((await store.reservations.getBySession("sbx_a"))?.state).toBe("SUSPENDED");

      // The reaper raced the resume and put the row back to SUSPENDED after
      // admission. Reassertion must restore the allocation without re-admitting
      // capacity that was already reserved.
      expect(await store.reservations.reassertAllocated("sbx_a")).toBe(true);
      expect((await store.reservations.getBySession("sbx_a"))?.state).toBe("ALLOCATED");
      expect(await store.reservations.reassertAllocated("sbx_a")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("converts a payment hold into a session reservation without releasing capacity", async () => {
    const store = freshStore();
    try {
      const paymentKey = "d".repeat(64);
      const hold = await store.reservations.admit(snapshot(), request(), {
        paymentKey,
        specHash: "d".repeat(64),
        ttlMs: 60_000,
      });
      expect(hold.admitted).toBe(true);

      const attached = await store.reservations.attachToSession(
        snapshot(),
        request(),
        paymentKey,
        "sbx_attached",
        "d".repeat(64),
      );
      expect(attached.admitted).toBe(true);
      expect((await store.reservations.getBySession("sbx_attached"))?.state).toBe("ALLOCATED");
      expect((await store.reservations.getByPayment(paymentKey))?.state).toBe("ALLOCATED");

      const blocked = await store.reservations.admit(snapshot(), request(), {
        sessionId: "sbx_other",
        state: "ALLOCATED",
      });
      expect(blocked.admitted).toBe(false);
    } finally {
      store.close();
    }
  });

  it("rebinds a reservation when a crash left an undurable session id", async () => {
    const store = freshStore();
    try {
      const paymentKey = "e".repeat(64);
      await store.reservations.admit(snapshot(), request(), {
        paymentKey,
        specHash: "e".repeat(64),
        ttlMs: 60_000,
      });
      const first = await store.reservations.attachToSession(
        snapshot(),
        request(),
        paymentKey,
        "sbx_never_inserted",
        "e".repeat(64),
      );
      expect(first.admitted).toBe(true);
      const rebound = await store.reservations.attachToSession(
        snapshot(),
        request(),
        paymentKey,
        "sbx_after_restart",
        "e".repeat(64),
      );
      expect(rebound.admitted).toBe(true);
      expect((await store.reservations.getBySession("sbx_after_restart"))?.state).toBe("ALLOCATED");
      expect(await store.reservations.getBySession("sbx_never_inserted")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("reconciles the reservation node with the node Kubernetes actually chose", async () => {
    const store = freshStore();
    try {
      await store.reservations.admit(snapshot(), request(), {
        sessionId: "sbx_move",
        state: "ALLOCATED",
      });
      expect(await store.reservations.pinNode("sbx_move", "node-b")).toBe(true);
      expect((await store.reservations.getBySession("sbx_move"))?.nodeId).toBe("node-b");
    } finally {
      store.close();
    }
  });

  it("keeps compute charged when an active session enters RELEASING", async () => {
    const store = freshStore();
    try {
      const snap = snapshot();
      expect((await store.reservations.admit(snap, request(), {
        sessionId: "sbx_active_release",
        state: "ALLOCATED",
      })).admitted).toBe(true);
      expect(await store.reservations.beginRelease("sbx_active_release", "pod-1")).toBe(true);

      const reservation = await store.reservations.getBySession("sbx_active_release");
      expect(reservation?.state).toBe("RELEASING");
      expect(reservation?.podName).toBe("pod-1");
      expect(holdsCompute(reservation!)).toBe(true);

      const node = snap.nodes[0]!;
      const releasing = availableOnNode(node, await store.reservations.listActive(), snap.now);
      expect(releasing.cpuMillicores).toBe(0);
      expect(releasing.memoryBytes).toBe(node.allocatable.memoryBytes - 512 * MiB);
      expect(releasing.storageBytes).toBe(node.allocatable.storageBytes - 1_024 * MiB);

      expect(await store.reservations.confirmRelease("sbx_active_release")).toBe(true);
      expect(availableOnNode(node, await store.reservations.listActive(), snap.now)).toEqual(node.allocatable);
    } finally {
      store.close();
    }
  });

  it("releases compute but not storage when a suspended session enters RELEASING", async () => {
    const store = freshStore();
    try {
      const snap = snapshot();
      expect((await store.reservations.admit(snap, request(), {
        sessionId: "sbx_suspended_release",
        state: "ALLOCATED",
      })).admitted).toBe(true);
      await store.reservations.updatePod("sbx_suspended_release", "pod-1");
      expect(await store.reservations.suspendSession("sbx_suspended_release")).toBe(true);

      // Termination can race the suspend and still hold the session row's
      // pre-suspend Pod name. The reservation must not adopt it: there is no
      // live Pod and compute was already returned.
      expect(await store.reservations.beginRelease("sbx_suspended_release", "pod-1")).toBe(true);
      const reservation = await store.reservations.getBySession("sbx_suspended_release");
      expect(reservation?.state).toBe("RELEASING");
      expect(reservation?.podName).toBeNull();
      expect(holdsCompute(reservation!)).toBe(false);

      const node = snap.nodes[0]!;
      const releasing = availableOnNode(node, await store.reservations.listActive(), snap.now);
      expect(releasing.cpuMillicores).toBe(node.allocatable.cpuMillicores);
      expect(releasing.memoryBytes).toBe(node.allocatable.memoryBytes);
      // The workspace is still charged until release is confirmed.
      expect(releasing.storageBytes).toBe(node.allocatable.storageBytes - 1_024 * MiB);

      // The returned compute is immediately usable while the workspace awaits
      // confirmation.
      expect((await store.reservations.admit(snap, request(), {
        sessionId: "sbx_reuser",
        state: "ALLOCATED",
      })).admitted).toBe(true);

      expect(await store.reservations.confirmRelease("sbx_suspended_release")).toBe(true);
      expect((await store.reservations.getBySession("sbx_suspended_release"))?.state).toBe("RELEASED");
    } finally {
      store.close();
    }
  });

  it("keeps capacity reserved in RELEASING until the Pod is confirmed gone", async () => {
    const store = freshStore();
    try {
      expect((await store.reservations.admit(snapshot(), request(), {
        sessionId: "sbx_release",
        state: "ALLOCATED",
      })).admitted).toBe(true);
      expect(await store.reservations.beginRelease("sbx_release", "pod-1")).toBe(true);
      expect((await store.reservations.getBySession("sbx_release"))?.state).toBe("RELEASING");

      const blocked = await store.reservations.admit(snapshot(), request(), {
        sessionId: "sbx_blocked",
        state: "ALLOCATED",
      });
      expect(blocked.admitted).toBe(false);

      expect(await store.reservations.confirmRelease("sbx_release")).toBe(true);
      expect((await store.reservations.getBySession("sbx_release"))?.state).toBe("RELEASED");
    } finally {
      store.close();
    }
  });

  it("expires provisional holds without leaking capacity", async () => {
    const store = freshStore();
    try {
      const now = Date.now();
      const hold = await store.reservations.admit(snapshot(now), request(), {
        paymentKey: "c".repeat(64),
        specHash: "c".repeat(64),
        ttlMs: 5_000,
      });
      expect(hold.admitted).toBe(true);
      expect(await store.reservations.reapExpiredHolds(now + 6_000)).toBeGreaterThanOrEqual(1);
      expect((await store.reservations.getByPayment("c".repeat(64)))?.state).toBe("RELEASED");

      const rehold = await store.reservations.admit(snapshot(now + 6_000), request(), {
        paymentKey: "c".repeat(64),
        specHash: "c".repeat(64),
        ttlMs: 5_000,
      });
      expect(rehold.admitted).toBe(true);
      expect((await store.reservations.getByPayment("c".repeat(64)))?.state).toBe("HELD");

      const after = await store.reservations.admit(snapshot(now + 6_000), request(), {
        sessionId: "sbx_after",
        state: "ALLOCATED",
      });
      expect(after.admitted).toBe(false); // rehold still owns the capacity
    } finally {
      store.close();
    }
  });
});
