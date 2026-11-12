/**
 * Checkpoint retention: which workspace PVCs may be deleted without a session.
 *
 * The checkpoint volume is plaintext (docs/adr/0007), so the sweep is the only
 * bound on how long an unowned one survives. A wrong delete loses a paid
 * session's data, so the conservative cases (unknown age, live session) are
 * tested as hard as the reap cases.
 */
import { describe, expect, it } from "vitest";
import { loadControllerConfig } from "../../controller/src/config.js";
import {
  workspacePvcReapReason,
  type WorkspacePvcInfo,
} from "../../controller/src/checkpoint-retention.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { ReconcilerContext } from "../../controller/src/reconciler-context.js";
import type { SessionRecord, Store } from "../../controller/src/store.js";
import { Termination } from "../../controller/src/termination.js";
import { testDatabaseUrl } from "../helpers/test-store.js";

const NOW = 1_700_000_000_000;
const GRACE = 3_600_000;

function pvc(overrides: Partial<WorkspacePvcInfo> = {}): WorkspacePvcInfo {
  return {
    name: "x402-ws-abc",
    sessionId: "sbx_abc",
    createdAt: NOW - GRACE - 1,
    deleting: false,
    ...overrides,
  };
}

describe("workspace PVC reap decision", () => {
  it("keeps a volume that a non-terminal session owns, whatever its age", () => {
    for (const state of ["PAID", "PROVISIONING", "READY", "ACTIVE", "SUSPENDING", "SUSPENDED", "RESUMING", "TERMINATING"]) {
      expect(
        workspacePvcReapReason({
          pvc: pvc({ createdAt: NOW - 365 * 24 * GRACE }),
          session: { id: "sbx_abc", state },
          now: NOW,
          orphanGraceMs: GRACE,
        }),
      ).toBeNull();
    }
  });

  it("reaps a volume whose session is already terminal", () => {
    for (const state of ["DESTROYED", "EXPIRED", "FAILED"]) {
      expect(
        workspacePvcReapReason({
          pvc: pvc({ createdAt: NOW }),
          session: { id: "sbx_abc", state },
          now: NOW,
          orphanGraceMs: GRACE,
        }),
      ).toBe("terminal_session");
    }
  });

  it("keeps an unowned volume inside the grace period", () => {
    expect(
      workspacePvcReapReason({
        pvc: pvc({ createdAt: NOW - GRACE + 1 }),
        session: null,
        now: NOW,
        orphanGraceMs: GRACE,
      }),
    ).toBeNull();
  });

  it("reaps an unowned volume once the grace period has elapsed", () => {
    expect(
      workspacePvcReapReason({
        pvc: pvc({ createdAt: NOW - GRACE }),
        session: null,
        now: NOW,
        orphanGraceMs: GRACE,
      }),
    ).toBe("no_session");
  });

  it("reaps an unowned volume with no session label after the grace period", () => {
    expect(
      workspacePvcReapReason({
        pvc: pvc({ sessionId: "", createdAt: NOW - GRACE }),
        session: null,
        now: NOW,
        orphanGraceMs: GRACE,
      }),
    ).toBe("unattributed");
  });

  it("does not report a volume that Kubernetes is already deleting", () => {
    expect(
      workspacePvcReapReason({
        pvc: pvc({ createdAt: NOW - GRACE, deleting: true }),
        session: null,
        now: NOW,
        orphanGraceMs: GRACE,
      }),
    ).toBeNull();
  });

  it("never reaps an unowned volume with an unknown age", () => {
    expect(
      workspacePvcReapReason({
        pvc: pvc({ createdAt: 0 }),
        session: null,
        now: NOW,
        orphanGraceMs: GRACE,
      }),
    ).toBeNull();
  });
});

function config() {
  return loadControllerConfig({
    ADMIN_TOKEN: "a".repeat(24),
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DATABASE_URL: testDatabaseUrl(),
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
  });
}

function harness(
  pvcs: WorkspacePvcInfo[],
  sessions: Record<string, Pick<SessionRecord, "id" | "state">>,
  opts: { listFails?: boolean; deleteFails?: string[] } = {},
) {
  const deleted: string[] = [];
  const cleared: string[] = [];
  const store = {
    getSession: (id: string) => sessions[id] ?? null,
    clearWorkspacePvc: (id: string) => {
      cleared.push(id);
    },
  } as unknown as Store;
  const provisioner = {
    listWorkspacePvcs: async () => {
      if (opts.listFails) throw new Error("kubernetes api unavailable");
      return pvcs;
    },
    deleteWorkspacePvc: async (name: string) => {
      if (opts.deleteFails?.includes(name)) throw new Error("volume in use");
      deleted.push(name);
    },
  } as unknown as Provisioner;
  const termination = new Termination({
    cfg: config(),
    store,
    provisioner,
    now: () => NOW,
  } as unknown as ReconcilerContext);
  return { termination, deleted, cleared };
}

describe("workspace PVC sweep", () => {
  const live = pvc({ name: "x402-ws-live", sessionId: "sbx_live", createdAt: NOW - 365 * GRACE });
  const terminal = pvc({ name: "x402-ws-done", sessionId: "sbx_done", createdAt: NOW });
  const orphan = pvc({ name: "x402-ws-orphan", sessionId: "sbx_orphan", createdAt: NOW - GRACE });
  const young = pvc({ name: "x402-ws-young", sessionId: "sbx_young", createdAt: NOW - 1 });
  const unattributed = pvc({ name: "x402-ws-x", sessionId: "", createdAt: NOW - GRACE });

  it("deletes only volumes without a live owner and clears the session record", async () => {
    const { termination, deleted, cleared } = harness(
      [live, terminal, orphan, young, unattributed],
      {
        sbx_live: { id: "sbx_live", state: "SUSPENDED" },
        sbx_done: { id: "sbx_done", state: "EXPIRED" },
        // sbx_orphan has no session row; sbx_young is inside the grace period
        sbx_young: { id: "sbx_young", state: "READY" },
      },
    );

    await termination.sweepPvcs();

    expect(deleted.sort()).toEqual(["x402-ws-done", "x402-ws-orphan", "x402-ws-x"].sort());
    expect(cleared).toEqual(["sbx_done"]);
  });

  it("does nothing when the provisioner cannot list volumes", async () => {
    const { termination, deleted } = harness([orphan], {}, { listFails: true });
    await expect(termination.sweepPvcs()).resolves.toBeUndefined();
    expect(deleted).toEqual([]);
  });

  it("keeps sweeping after one delete fails", async () => {
    const { termination, deleted } = harness(
      [terminal, orphan],
      { sbx_done: { id: "sbx_done", state: "FAILED" } },
      { deleteFails: ["x402-ws-done"] },
    );

    await termination.sweepPvcs();

    expect(deleted).toEqual(["x402-ws-orphan"]);
  });
});

describe("orphan PVC grace config", () => {
  it("defaults to one hour and accepts an override", () => {
    expect(config().orphanPvcGraceMs).toBe(3_600_000);
    expect(
      loadControllerConfig({
        ADMIN_TOKEN: "a".repeat(24),
        ROLE: "all",
        EXECUTION_MODE: "dev",
        ALLOW_INSECURE_DEV: "true",
        KUBERNETES_ENABLED: "false",
        DATABASE_URL: testDatabaseUrl(),
        RELAY_ADMIN_TOKEN: "r".repeat(24),
        WAKE_TOKEN: "w".repeat(24),
        PROXY_TOKEN_SECRET: "p".repeat(24),
        ORPHAN_PVC_GRACE_MS: "60000",
      }).orphanPvcGraceMs,
    ).toBe(60_000);
  });

  it("rejects a grace period that would delete checkpoints immediately", () => {
    expect(() =>
      loadControllerConfig({
        ADMIN_TOKEN: "a".repeat(24),
        ROLE: "all",
        EXECUTION_MODE: "dev",
        ALLOW_INSECURE_DEV: "true",
        KUBERNETES_ENABLED: "false",
        DATABASE_URL: testDatabaseUrl(),
        RELAY_ADMIN_TOKEN: "r".repeat(24),
        WAKE_TOKEN: "w".repeat(24),
        PROXY_TOKEN_SECRET: "p".repeat(24),
        ORPHAN_PVC_GRACE_MS: "59",
      }),
    ).toThrow(/ORPHAN_PVC_GRACE_MS|invalid integer config/);
  });
});
