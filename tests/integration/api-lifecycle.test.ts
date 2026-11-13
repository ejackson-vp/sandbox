/**
 * Suspend, resume, destroy and the races between them.
 *
 * Split out of api-flow.test.ts. These cases are about a session changing state
 * while an operator is also changing it: the idle policy suspending a session,
 * a suspended session expiring, the workspace surviving a suspend with a
 * rotated guest key, destroy winning against an in-flight suspend or resume,
 * and capacity staying reserved while a deleted Pod is still observed. The
 * payment and execution suites share this stack through
 * support/api-harness.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LocalProvisioner } from "../../controller/src/local-provisioner.js";
import type { Reconciler } from "../../controller/src/reconciler.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import type { SessionStatus } from "../../shared/src/entries/protocol.js";
import { SandboxError } from "../../sdk/src/index.js";
import type { SandboxClient, SessionHandle } from "../../sdk/src/index.js";
import {
  sleep,
  startHarness,
  type Harness,
  type RecordingSnapshotter,
} from "./support/api-harness.js";

let harness: Harness;
let apiUrl: string;
let client: SandboxClient;
let store: PostgresStore;
let provisioner: LocalProvisioner;
let reconciler: Reconciler;
let snapshotter: RecordingSnapshotter;
let pollStatus: Harness["pollStatus"];

beforeAll(async () => {
  harness = await startHarness({ namespace: "integration-api-lifecycle", portOffset: 20 });
  apiUrl = harness.apiUrl;
  client = harness.client;
  store = harness.store;
  provisioner = harness.provisioner;
  reconciler = harness.reconciler;
  snapshotter = harness.snapshotter;
  pollStatus = harness.pollStatus;
});

afterAll(async () => {
  await harness.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkpoint and resume", () => {
  it("auto-suspends after the idle policy", async () => {
    const handle = await client.createSession({
      tier: "custom",
      durationSeconds: 60,
      idlePolicy: { maxIdleSeconds: 1, suspendedDurationSeconds: 60, autoResume: false },
    });
    await client.waitForReady(handle);
    const suspended = await pollStatus(handle, (s) => s.state === "SUSPENDED", 20_000);
    expect(suspended.suspendedAt).toBeDefined();
    expect(suspended.remainingSeconds).toBe(0);
    await client.resume(handle);
    await client.destroy(handle);
  }, 120_000);

  it("expires a session that stays suspended too long", async () => {
    const handle = await client.createSession({
      tier: "custom",
      durationSeconds: 60,
      idlePolicy: { maxIdleSeconds: 300, suspendedDurationSeconds: 1, autoResume: false },
    });
    await client.waitForReady(handle);
    await client.suspend(handle);
    const terminal = await pollStatus(
      handle,
      (s) => s.state === "EXPIRED" || s.state === "FAILED" || s.state === "DESTROYED",
      15_000,
    );
    expect(terminal.state).toBe("EXPIRED");
  }, 120_000);

  it("exposes the pinned image digest", async () => {
    const res = await fetch(`${apiUrl}/v1/images`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { images: Array<{ id: string; digest: string; current: boolean }> };
    expect(body.images[0]?.id).toBe("guest");
    expect(body.images[0]?.digest).toMatch(/^sha256:/);
    expect(body.images[0]?.current).toBe(true);
  });

  it("persists the workspace, rotates the guest key, and resumes", async () => {
    const handle = await client.createSession({
      tier: "custom",
      durationSeconds: 60,
      idlePolicy: { maxIdleSeconds: 300, suspendedDurationSeconds: 600, autoResume: false },
    });
    await client.waitForReady(handle);
    const put = await client.putFile(handle, {
      path: "persist.txt",
      data: Buffer.from("keep-me"),
    });
    expect("ok" in put && put.ok).toBe(true);
    const keyBefore = handle.guestPublicKey;
    expect(keyBefore).toBeDefined();

    const suspended = await client.suspend(handle);
    expect(suspended.state).toBe("SUSPENDED");
    expect(suspended.remainingSeconds).toBe(0);
    expect(snapshotter.captured).toContain(handle.sessionId);

    await expect(client.exec(handle, { command: ["cat", "persist.txt"] })).rejects.toMatchObject({
      code: "session_suspended",
    });

    const resumed = await client.resume(handle);
    expect(resumed.state).toBe("READY");
    expect(snapshotter.restored).toContain(handle.sessionId);
    expect(handle.guestPublicKey).toBeDefined();
    expect(Buffer.from(handle.guestPublicKey!).equals(Buffer.from(keyBefore!))).toBe(false);

    const read = await client.exec(handle, { command: ["cat", "persist.txt"] });
    expect("stdout" in read && read.stdout.trim()).toBe("keep-me");
    await client.destroy(handle);
    expect(snapshotter.discarded).toContain(handle.sessionId);
  }, 180_000);
});

describe("lifecycle races", () => {
  async function suspendableSession(): Promise<SessionHandle> {
    const handle = await client.createSession({
      tier: "custom",
      durationSeconds: 60,
      idlePolicy: { maxIdleSeconds: 300, suspendedDurationSeconds: 600, autoResume: false },
    });
    await client.waitForReady(handle);
    return handle;
  }

  async function expectNoPods(sessionId: string): Promise<void> {
    const pods = await provisioner.listSandboxPods();
    expect(pods.filter((pod) => pod.sessionId === sessionId)).toHaveLength(0);
  }

  async function waitForDestroyRequested(sessionId: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await store.getSession(sessionId))?.destroyRequested === 1) return;
      await sleep(50);
    }
    throw new Error("destroy request was not recorded");
  }

  it("destroys a suspended session instead of orphaning it", async () => {
    const handle = await suspendableSession();
    await client.suspend(handle);
    expect((await store.getSession(handle.sessionId))?.state).toBe("SUSPENDED");

    const destroyed = await client.destroy(handle, 20_000);
    expect(destroyed?.state).toBe("DESTROYED");
    const row = await store.getSession(handle.sessionId);
    expect(row?.state).toBe("DESTROYED");
    expect(row?.workspacePvc).toBeNull();
    await expectNoPods(handle.sessionId);
  }, 60_000);

  it("serialises concurrent suspend requests without leaving a pod", async () => {
    const handle = await suspendableSession();
    const results = await Promise.allSettled([client.suspend(handle), client.suspend(handle)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect((rejected?.reason as SandboxError).code).toBe("not_suspendable");
    expect((await store.getSession(handle.sessionId))?.state).toBe("SUSPENDED");
    await expectNoPods(handle.sessionId);

    await client.destroy(handle, 20_000);
    expect((await store.getSession(handle.sessionId))?.state).toBe("DESTROYED");
  }, 60_000);

  it("lets destroy win while a suspend is between SUSPENDING and SUSPENDED", async () => {
    const handle = await suspendableSession();
    const originalSuspend = provisioner.suspendPod.bind(provisioner);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(provisioner, "suspendPod").mockImplementation(async (podName) => {
      await gate;
      return originalSuspend(podName);
    });

    let destroyed: SessionStatus | null | undefined;
    try {
      const suspend = client.suspend(handle).then(
        () => null,
        (err: Error) => err,
      );
      await pollStatus(handle, (status) => status.state === "SUSPENDING", 10_000);
      const destroy = client.destroy(handle, 20_000);
      await waitForDestroyRequested(handle.sessionId);
      release();
      destroyed = await destroy;
      await suspend;
    } finally {
      release();
      await client.destroy(handle, 10_000).catch(() => undefined);
    }

    expect(destroyed?.state).toBe("DESTROYED");
    expect((await store.getSession(handle.sessionId))?.state).toBe("DESTROYED");
    await expectNoPods(handle.sessionId);
  }, 60_000);

  it("lets destroy win while a resume is between SUSPENDED and RESUMING", async () => {
    const handle = await suspendableSession();
    await client.suspend(handle);
    const provisioning = (reconciler as unknown as {
      provisioning: { awaitReady: (session: SessionRecord) => Promise<void> };
    }).provisioning;
    const originalAwaitReady = provisioning.awaitReady.bind(provisioning);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(provisioning, "awaitReady").mockImplementation(async (session) => {
      await gate;
      return originalAwaitReady(session);
    });

    let destroyed: SessionStatus | null | undefined;
    try {
      const resume = client.resume(handle).then(
        () => null,
        (err: Error) => err,
      );
      await pollStatus(handle, (status) => status.state === "RESUMING", 10_000);
      const destroy = client.destroy(handle, 20_000);
      await waitForDestroyRequested(handle.sessionId);
      release();
      destroyed = await destroy;
      await resume;
    } finally {
      release();
      await client.destroy(handle, 10_000).catch(() => undefined);
    }

    expect(destroyed?.state).toBe("DESTROYED");
    expect((await store.getSession(handle.sessionId))?.state).toBe("DESTROYED");
    await expectNoPods(handle.sessionId);
  }, 60_000);

  it("accepts duplicate destroys and still reaches a single terminal state", async () => {
    const handle = await suspendableSession();
    const results = await Promise.allSettled([
      client.destroy(handle, 20_000),
      client.destroy(handle, 20_000),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect((await store.getSession(handle.sessionId))?.state).toBe("DESTROYED");
    await expectNoPods(handle.sessionId);
  }, 60_000);
});

describe("control-plane failure recovery", () => {
  it("keeps capacity reserved while a deleted Pod is still observed", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60, cpuMillis: 500, memoryMiB: 512, diskMiB: 256 });
    await client.waitForReady(handle);
    const original = provisioner.deletePod.bind(provisioner);
    provisioner.deletePod = async () => {
      throw new Error("simulated persistent Pod deletion failure");
    };
    try {
      await client.destroy(handle);
      let state = "";
      for (let i = 0; i < 30; i += 1) {
        state = (await store.reservations.getBySession(handle.sessionId))?.state ?? "gone";
        if (state === "RELEASING") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(state).toBe("RELEASING");
    } finally {
      provisioner.deletePod = original;
    }
    let finalState = "";
    for (let i = 0; i < 40; i += 1) {
      finalState = (await store.reservations.getBySession(handle.sessionId))?.state ?? "gone";
      if (finalState === "RELEASED" || finalState === "gone") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(["RELEASED", "gone"]).toContain(finalState);
  }, 30_000);
});
