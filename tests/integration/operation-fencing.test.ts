/**
 * Controller-restart fencing against a real guest.
 *
 * The guest process and relay survive; only the controller store and control
 * API are recreated, which is the production shape (relay and controller are
 * separate Deployments). The test drives the state transitions itself instead
 * of sleeping and hoping: it waits for the guest's own status report before
 * asserting, and releases the fence by cancelling the old command.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { openSealedJson, sealJsonTo } from "@x402s/shared/crypto";
import type { SessionLimits } from "@x402s/shared/protocol";
import { createControlApi } from "../../controller/src/control-api.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import { OperationFence } from "../../controller/src/operation-fence.js";
import { RelayClient } from "../../controller/src/relay-client.js";
import type {  PaymentRecord, SessionRecord  } from "../../controller/src/store/models.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import { GuestHarness } from "../helpers/guest.js";
import { freshStore, openStore, testDatabaseUrl } from "../helpers/test-store.js";
import { testPort } from "./ports.js";

const RELAY_PORT = testPort(18870);
const CONTROLLER_PORT = testPort(18871);
const ADMIN = "fencing-admin-token-0123456789";
const CONFIG = loadControllerConfig({
  ADMIN_TOKEN: ADMIN,
  RELAY_ADMIN_TOKEN: "r".repeat(24),
  WAKE_TOKEN: "w".repeat(24),
  PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
  ROLE: "controller",
  KUBERNETES_ENABLED: "false",
  DATABASE_URL: testDatabaseUrl("integration"),
});

const limits: SessionLimits = {
  cpuMillis: 500,
  memoryMiB: 512,
  diskMiB: 256,
  maxOutputBytes: 262_144,
  maxFileBytes: 8 * 1024 * 1024,
  maxCommandSeconds: 300,
  maxProcesses: 256,
};

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
    durationSeconds: 300,
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
  const key = "f".repeat(64);
  const claim = await store.claimPaymentIntent(key, "fence-spec", 30_000);
  if (claim.status !== "claimed") throw new Error("expected claim");
  await store.completeEntitlement(key, claim.token, paymentRecord(key), sessionRecord(sessionId, key));
  await store.setProvisioning(sessionId, "pod-fence");
  await store.setRelayToken(sessionId, "relay-hash");
  await store.setReady(sessionId, Date.now(), Date.now() + 120_000, "{}", "guestpk");
}

async function listen(app: http.RequestListener, port: number): Promise<http.Server> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  return server;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function callJson(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${CONTROLLER_PORT}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-internal-token": ADMIN },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("controller restart fences an in-flight operation", () => {
  let guest: GuestHarness;
  let relay: RelayClient;
  let store: PostgresStore;
  let server: http.Server;
  const sessionIdRef = () => guest.sessionId;

  async function waitForGuestState(predicate: (state: Awaited<ReturnType<RelayClient["state"]>>) => boolean, label: string) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const state = await relay.state(sessionIdRef());
      if (predicate(state)) return state;
      if (Date.now() >= deadline) throw new Error(`timeout waiting for ${label}: ${JSON.stringify(state)}`);
      await sleep(25);
    }
  }

  beforeAll(async () => {
    guest = new GuestHarness({ port: RELAY_PORT, leaseSeconds: 120, maxCommandSeconds: 120 });
    await guest.start();
    relay = new RelayClient({ baseUrl: `http://127.0.0.1:${RELAY_PORT}`, adminToken: "harness-admin-token-0123456789" });
    store = await freshStore({ namespace: "integration" });
    await seedReadySession(store, guest.sessionId);
    server = await listen(
      createControlApi({
        cfg: CONFIG,
        store,
        relay,
        // The operations routes never touch capacity; the router is inert here.
        capacity: {} as CapacityService,
      }),
      CONTROLLER_PORT,
    );
    await waitForGuestState((state) => state.connected && state.statusAt !== undefined, "guest status");
  });

  afterAll(async () => {
    if (server) await close(server).catch(() => undefined);
    await store?.close();
    await guest?.stop();
  });

  it("keeps the gate closed until the guest finishes, then admits the next operation", async () => {
    const sessionId = guest.sessionId;
    const oldRequestId = "fence-old-request-0001";

    // 1. A long operation is in flight in the guest.
    const claim = await store.claimOperation(sessionId, oldRequestId, "exec");
    expect(claim).toMatchObject({ ok: true, epoch: 1 });
    const envelope = await sealJsonTo(guest.guestKey!, {
      v: 2,
      sessionId,
      clientNonce: guest.clientNonce,
      requestId: oldRequestId,
      op: "exec",
      command: ["sleep", "30"],
      timeoutMs: 60_000,
    });
    await relay.request(sessionId, oldRequestId, envelope, Date.now() + 120_000, 1);
    await waitForGuestState((state) => state.activeRequestId === oldRequestId, "old request active");

    // 2. The controller crashes: only the store and HTTP surface are replaced.
    await close(server);
    await store.close();
    store = await openStore({ namespace: "integration" });
    expect(await store.recoverInterruptedOperations()).toEqual({ requests: 1, sessions: 1 });
    expect(await store.getExecRequest(sessionId, oldRequestId)).toMatchObject({
      state: "outcome_unknown",
      epoch: 1,
    });
    expect(await store.getSession(sessionId)).toMatchObject({
      activeRequestId: oldRequestId,
      execEpoch: 2,
    });

    const fence = new OperationFence(store, relay);
    expect(await fence.reconcile()).toEqual({ cleared: 0, held: 1, errors: 0 });

    server = await listen(
      createControlApi({ cfg: CONFIG, store, relay, capacity: {} as CapacityService }),
      CONTROLLER_PORT,
    );

    // 3. A new operation is refused before any frame reaches the guest.
    const pendingBefore = (await relay.state(sessionId)).pending;
    const refused = await callJson("POST", `/internal/sessions/${sessionId}/operations`, {
      requestId: "fence-new-request-0001",
      envelope,
      op: "exec",
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "busy", requestId: oldRequestId });
    expect((await relay.state(sessionId)).pending).toBe(pendingBefore);
    expect((await store.listFencedSessions()).map((session) => session.id)).toEqual([sessionId]);

    // 4. The old request is a defined outcome, never a success/failure/expiry.
    const unknown = await callJson(
      "GET",
      `/internal/sessions/${sessionId}/operations/${oldRequestId}?waitMs=0`,
    );
    expect(unknown.status).toBe(409);
    expect(unknown.body).toMatchObject({ error: "outcome_unknown", requestId: oldRequestId });

    const neverSeen = await callJson(
      "GET",
      `/internal/sessions/${sessionId}/operations/fence-never-seen`,
    );
    expect(neverSeen.status).toBe(404);
    expect(neverSeen.body).toMatchObject({ error: "request_not_found" });

    // 5. Cancel the fenced request. The guest's own status report is the clock:
    //    the gate clears only after it says the slot is idle.
    const cancelled = await callJson(
      "DELETE",
      `/internal/sessions/${sessionId}/operations/${oldRequestId}`,
    );
    expect(cancelled.status).toBe(202);
    await waitForGuestState((state) => state.activeRequestId === "", "guest slot idle");
    expect(await fence.reconcile()).toEqual({ cleared: 1, held: 0, errors: 0 });
    expect((await store.getSession(sessionId))?.activeRequestId).toBeNull();

    // 6. The next operation is admitted under the new epoch and succeeds.
    const newRequestId = "fence-new-request-0002";
    const newEnvelope = await sealJsonTo(guest.guestKey!, {
      v: 2,
      sessionId,
      clientNonce: guest.clientNonce,
      requestId: newRequestId,
      op: "exec",
      command: ["echo", "after-fence"],
      timeoutMs: 5_000,
    });
    const accepted = await callJson("POST", `/internal/sessions/${sessionId}/operations`, {
      requestId: newRequestId,
      envelope: newEnvelope,
      op: "exec",
    });
    expect(accepted.status).toBe(200);
    const result = await openSealedJson<{ ok: boolean; stdout: string }>(
      String(accepted.body.envelope),
      guest.clientKeys.publicKey,
      guest.clientKeys.privateKey,
    );
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("after-fence");
    expect(await store.getExecRequest(sessionId, newRequestId)).toMatchObject({ state: "done", epoch: 2 });

    // 7. A frame from the old generation is refused before it can reach the
    //    guest. The relay enforces the session epoch floor that recovery
    //    published; the guest's own high-water check remains defense in depth.
    const staleRequestId = "fence-stale-request-01";
    const staleEnvelope = await sealJsonTo(guest.guestKey!, {
      v: 2,
      sessionId,
      clientNonce: guest.clientNonce,
      requestId: staleRequestId,
      op: "exec",
      command: ["echo", "must-not-run"],
      timeoutMs: 5_000,
    });
    await expect(
      relay.request(sessionId, staleRequestId, staleEnvelope, Date.now() + 60_000, 1),
    ).rejects.toThrowError(/stale_epoch/);
    expect((await relay.state(sessionId)).pending).toBe(0);
  }, 60_000);
});
