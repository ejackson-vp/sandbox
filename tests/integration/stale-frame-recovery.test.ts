/**
 * Regression for issue #88: a frame forwarded by a controller generation that
 * recovery has already superseded must not start at the guest.
 *
 * The frame is put in exactly the position the #75 model found: the previous
 * generation called the relay, which wrote the frame to the guest's socket, but
 * the guest process is stopped and has not read it. Then the controller
 * "crashes" and recovery bumps `sessions.exec_epoch`.
 *
 * The relay is the epoch authority after recovery. `OperationFence.reconcile`
 * publishes the bumped epoch before it trusts the relay's view; the relay
 * withdraws the pending frame and resets the guest link, so the queued bytes
 * are discarded instead of executed when the guest resumes.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sealJsonTo } from "@x402s/shared/crypto";
import type { SessionLimits } from "@x402s/shared/protocol";
import { OperationFence } from "../../controller/src/operation-fence.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type {  PaymentRecord, SessionRecord  } from "../../controller/src/store/models.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { GuestHarness } from "../helpers/guest.js";
import { freshStore, openStore } from "../helpers/test-store.js";
import { testPort } from "./ports.js";

const limits: SessionLimits = {
  cpuMillis: 500,
  memoryMiB: 512,
  diskMiB: 256,
  maxOutputBytes: 262_144,
  maxFileBytes: 8 * 1024 * 1024,
  maxCommandSeconds: 120,
  maxProcesses: 256,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function paymentRecord(key: string): PaymentRecord {
  return {
    paymentKey: key,
    network: "mock:local",
    scheme: "exact",
    asset: "mock:usdc",
    amount: "50000",
    payTo: "0x0000000000000000000000000000000000000402",
    mode: "mock",
  };
}

function sessionRecord(id: string, key: string): SessionRecord {
  const now = Date.now();
  return {
    id,
    capabilityHash: "a".repeat(64),
    capabilityExpiresAt: now + 3_600_000,
    clientPublicKey: "pk",
    clientNonce: "nonce",
    clientSigner: null,
    tier: "custom",
    durationSeconds: 120,
    limits,
    state: "PAID",
    createdAt: now,
    paidAt: now,
    readyAt: null,
    leaseExpiresAt: null,
    terminatingAt: null,
    destroyedAt: null,
    terminationReason: null,
    failureCode: null,
    failureMessage: null,
    attestationJson: null,
    guestPublicKey: null,
    paymentKey: key,
    podName: null,
    runtimeClass: "x402-sandbox",
    executionMode: "dev",
    relayTokenHash: null,
    activeRequestId: null,
    execEpoch: 1,
    relayPurgedAt: null,
    destroyRequested: 0,
    timingsJson: null,
    idlePolicyJson: null,
    maxLifetimeSeconds: null,
    suspendedAt: null,
    resumeCount: 0,
    lastActivityAt: null,
    workspacePvc: null,
    baselineCpuMillis: null,
    baselineMemoryMib: null,
    nodeName: null,
    updatedAt: now,
  };
}

async function seedReadySession(store: PostgresStore, sessionId: string): Promise<void> {
  const key = "e".repeat(64);
  const claim = await store.claimPaymentIntent(key, "stale-frame-spec", 30_000);
  if (claim.status !== "claimed") throw new Error("expected claim");
  await store.completeEntitlement(key, claim.token, paymentRecord(key), sessionRecord(sessionId, key));
  await store.setProvisioning(sessionId, "pod-stale-frame");
  await store.setRelayToken(sessionId, "relay-hash");
  await store.setReady(sessionId, Date.now(), Date.now() + 120_000, "{}", "guestpk");
}

async function waitFor(
  relay: RelayClient,
  sessionId: string,
  predicate: (state: Awaited<ReturnType<RelayClient["state"]>>) => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const state = await relay.state(sessionId);
    if (predicate(state)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(state)}`);
    await sleep(25);
  }
}

describe("recovery withdraws a stale frame the guest has not observed", () => {
  it("never starts the superseded generation's command and admits the next epoch", async () => {
    const guest = new GuestHarness({ port: testPort(18890), leaseSeconds: 120, maxCommandSeconds: 120 });
    await guest.start();
    let store: PostgresStore | undefined;

    try {
      const relay = guest.relayClient;
      const sessionId = guest.sessionId;
      store = await freshStore({ namespace: "integration" });
      await seedReadySession(store, sessionId);

      // The guest has connected and published its own (empty) execution state.
      await waitFor(relay, sessionId, (state) => state.statusAt !== undefined, "guest status");

      const oldRequestId = "stale-frame-old-request";
      expect(await store.claimOperation(sessionId, oldRequestId, "exec")).toMatchObject({ ok: true, epoch: 1 });

      const envelope = await sealJsonTo(guest.guestKey!, {
        v: 2,
        sessionId,
        clientNonce: guest.clientNonce,
        requestId: oldRequestId,
        op: "exec",
        command: ["sh", "-c", "printf ran > stale-frame-marker"],
        timeoutMs: 60_000,
      });

      // Freeze the guest so the next frame stays in its socket queue: this is
      // "forwarded before recovery, not yet observed".
      guest.pause();
      await sleep(100);
      await relay.request(sessionId, oldRequestId, envelope, Date.now() + 120_000, 1);
      const beforeRecovery = await relay.state(sessionId);
      expect(beforeRecovery.pending).toBe(1);
      // The frame is queued, not observed: no guest command may be active and
      // the guest's own epoch must be behind the recovery epoch. If either is
      // false the reset path is allowed to skip, and this test's premise is gone.
      expect(beforeRecovery.activeRequestId).toBe("");
      expect(beforeRecovery.execEpoch).toBeLessThan(2);

      // The controller crashes. Only the store is replaced: the relay and the
      // (frozen) guest survive, exactly like a controller Deployment restart.
      await store.close();
      store = await openStore({ namespace: "integration" });
      expect(await store.recoverInterruptedOperations()).toEqual({ requests: 1, sessions: 1 });
      expect(await store.getSession(sessionId)).toMatchObject({ activeRequestId: oldRequestId, execEpoch: 2 });
      expect(await store.getExecRequest(sessionId, oldRequestId)).toMatchObject({
        state: "outcome_unknown",
        epoch: 1,
      });

      // Recovery publishes epoch 2 to the relay, which withdraws the queued
      // frame and resets the link. The fence then clears because no command can
      // survive that link.
      const fence = new OperationFence(store, relay);
      expect(await fence.reconcile()).toEqual({ cleared: 1, held: 0, errors: 0 });
      expect(await relay.state(sessionId)).toMatchObject({
        connected: false,
        pending: 0,
        epochFloor: 2,
      });
      expect((await store.getSession(sessionId))?.activeRequestId).toBeNull();

      // Let the guest run. The withdrawn frame must have been discarded: the
      // command would have written the marker if the guest had read it. The
      // supervisor no longer exits on link loss: it reconnects with the same
      // identity, so the session survives with its workspace.
      guest.resume();
      await waitFor(
        relay,
        sessionId,
        (state) => state.connected && state.statusAt !== undefined,
        "guest reconnected",
      );
      expect((await relay.state(sessionId)).epochFloor).toBe(2);
      expect(guest.proc?.exitCode ?? null).toBeNull();
      await sleep(200);
      expect(existsSync(join(guest.workspace, "stale-frame-marker"))).toBe(false);

      // A frame still carrying the old generation is refused by the relay, so
      // it cannot reach a restarted guest either.
      await expect(
        relay.request(sessionId, "stale-frame-late-request", envelope, Date.now() + 60_000, 1),
      ).rejects.toThrowError(/stale_epoch/);

      // The gate is free and the next operation is claimed under epoch 2. No
      // new command can overlap the withdrawn one.
      const newRequestId = "stale-frame-new-request";
      expect(await store.claimOperation(sessionId, newRequestId, "exec")).toMatchObject({ ok: true, epoch: 2 });
      await store.finishOperation(sessionId, newRequestId, "abandoned");
    } finally {
      try {
        guest.resume();
      } catch {
        /* already gone */
      }
      await store?.close();
      await guest.stop().catch(() => undefined);
    }
  }, 60_000);

  it("clears the fence without a guest connection so recovery still progresses", async () => {
    const guest = new GuestHarness({ port: testPort(18891), leaseSeconds: 120 });
    await guest.start();
    let store: PostgresStore | undefined;

    try {
      const relay = guest.relayClient;
      const sessionId = guest.sessionId;
      store = await freshStore({ namespace: "integration" });
      await seedReadySession(store, sessionId);

      const oldRequestId = "stale-frame-idle-old";
      expect(await store.claimOperation(sessionId, oldRequestId, "exec")).toMatchObject({ ok: true, epoch: 1 });

      // The guest goes away before the controller restarts. The frame was never
      // forwarded (the controller died between the claim and the relay call).
      guest.proc?.kill("SIGKILL");
      await waitFor(relay, sessionId, (state) => !state.connected, "guest disconnect");

      await store.close();
      store = await openStore({ namespace: "integration" });
      expect(await store.recoverInterruptedOperations()).toEqual({ requests: 1, sessions: 1 });

      const fence = new OperationFence(store, relay);
      expect(await fence.reconcile()).toEqual({ cleared: 1, held: 0, errors: 0 });
      expect((await store.getSession(sessionId))?.activeRequestId).toBeNull();
      expect((await store.getSession(sessionId))?.execEpoch).toBe(2);

      expect(await store.claimOperation(sessionId, "stale-frame-idle-new", "exec")).toMatchObject({
        ok: true,
        epoch: 2,
      });
      await store.finishOperation(sessionId, "stale-frame-idle-new", "abandoned");
    } finally {
      await store?.close();
      await guest.stop().catch(() => undefined);
    }
  }, 60_000);
});
