/**
 * A relay restart must not kill a paid session.
 *
 * The relay registry is in memory and one process per shard, so a restart drops
 * every guest socket. Before reconnect support the supervisor exited with its
 * link, the Pod went terminal, and the controller failed the session with
 * `failure:guest_exited`. This test drives the real guest, the real relay, a
 * second relay process on the same address, the real reconciler and a real
 * Postgres store:
 *
 *   READY with an exec in flight
 *     -> relay killed and replaced (new generation)
 *     -> controller fences the request `outcome_unknown`, bumps the epoch and
 *        re-registers the session on the replacement
 *     -> guest reconnects, hello + idle status
 *     -> fence releases, session stays READY with the same lease
 *     -> a retry of the old request id is 409 outcome_unknown, a new one runs
 *     -> the workspace file survives
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fromBase64,
  generateBoxKeyPair,
  generateNonce,
  openSealedJson,
  sealJsonTo,
  toBase64,
} from "@x402s/shared/crypto";
import type { SessionLimits } from "@x402s/shared/protocol";
import { loadControllerConfig } from "../../controller/src/config.js";
import { CapacityService } from "../../controller/src/capacity/service.js";
import { createControlApi } from "../../controller/src/control-api.js";
import { createRelay, type RelayServer } from "../../controller/src/relay.js";
import { RelayClient } from "../../controller/src/relay-client.js";
import { Reconciler } from "../../controller/src/reconciler.js";
import { OperationFence } from "../../controller/src/operation-fence.js";
import type { PaymentRecord, SessionRecord } from "../../controller/src/store/models.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { LocalProvisioner } from "../../controller/src/local-provisioner.js";
import { freshStore, testDatabaseUrl } from "../helpers/test-store.js";
import { testPort } from "./ports.js";

const RELAY_ADMIN = "r".repeat(24);
const ADMIN = "relay-reconnect-admin-0123456789";
const DEV_SEED = "qSgP+dPwGhb/58O0ZD/dSqCMovhhWNIQbT3MeTD35WY=";
const GUEST_BINARY = process.env.GUEST_BINARY ?? join(process.cwd(), "guest/bin/x402-guest");

process.env.DEV_ATTESTATION_KEY = DEV_SEED;
process.env.DEV_ATTESTATION_KEY_ID = "x402-dev-attestation-key-INSECURE-DEV-ONLY";

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

function sessionRecord(
  id: string,
  key: string,
  clientPublicKey: string,
  clientNonce: string,
  durationSeconds: number,
): SessionRecord {
  const now = Date.now();
  return {
    id,
    capabilityHash: "a".repeat(64),
    capabilityExpiresAt: now + 3_600_000,
    clientPublicKey,
    clientNonce,
    clientSigner: null,
    tier: "custom",
    durationSeconds,
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

async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await sleep(50);
  }
}

async function listen(app: http.RequestListener, port: number): Promise<http.Server> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

interface Run {
  store: PostgresStore;
  sessionId: string;
  workDir: string;
  workspaceFile: string;
  relay: RelayServer;
  relayPort: number;
  relayClient: RelayClient;
  provisioner: LocalProvisioner;
  reconciler: Reconciler;
  control: http.Server;
  clientKeys: Awaited<ReturnType<typeof generateBoxKeyPair>>;
  clientNonce: string;
  guestPublicKey: string;
  leaseExpiresAt: number;
  podName: string;
  /** Restart the relay process on the same address with a new generation. */
  restartRelay(): Promise<void>;
  cleanup(): Promise<void>;
}

async function startRelay(port: number): Promise<RelayServer> {
  const relay = createRelay({ adminToken: RELAY_ADMIN, responseTtlMs: 60_000 });
  await new Promise<void>((resolve) => relay.server.listen(port, "127.0.0.1", resolve));
  return relay;
}

async function scenario(
  graceMs: number,
  suffix: string,
  opts: { leaseSeconds?: number } = {},
): Promise<Run> {
  const durationSeconds = opts.leaseSeconds ?? 180;
  const relayPort = testPort(18892);
  const controlPort = testPort(18893);
  const workDir = mkdtempSync(join(tmpdir(), "x402-relay-reconnect-"));
  let relay = await startRelay(relayPort);

  const store = await freshStore({ namespace: "integration" });
  const cfg = loadControllerConfig({
    ADMIN_TOKEN: ADMIN,
    ROLE: "controller",
    KUBERNETES_ENABLED: "false",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    DATABASE_URL: testDatabaseUrl("integration"),
    RELAY_URL: `http://127.0.0.1:${relayPort}`,
    RELAY_SERVICE_NAME: "relay",
    PROXY_SERVICE_NAME: "egress-proxy",
    RELAY_ADMIN_TOKEN: RELAY_ADMIN,
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
    GUEST_IMAGE: "x402-sandbox/guest:dev",
    RECONCILE_INTERVAL_MS: "100",
    PROVISIONING_TIMEOUT_MS: "20000",
    RELAY_REGISTRATION_TIMEOUT_MS: "3000",
    RELAY_LOSS_GRACE_MS: String(graceMs),
    ALLOW_CUSTOM_DURATIONS: "true",
  });

  const provisioner = new LocalProvisioner({
    binary: GUEST_BINARY,
    relayHost: "127.0.0.1",
    relayPort,
    proxyHost: "127.0.0.1",
    proxyPort: 3128,
    workRoot: join(workDir, "sandboxes"),
  });
  const capacity = new CapacityService({ cfg, store, provisioner });
  const relayClient = new RelayClient({
    baseUrl: `http://127.0.0.1:${relayPort}`,
    adminToken: RELAY_ADMIN,
    timeoutMs: 1_000,
  });
  const fence = new OperationFence(store, relayClient);
  const reconciler = new Reconciler({ cfg, store, provisioner, relay: relayClient, capacity, fence });
  const control = await listen(
    createControlApi({ cfg, store, relay: relayClient, capacity: {} as CapacityService }),
    controlPort,
  );

  const clientKeys = await generateBoxKeyPair();
  const clientNonce = toBase64(await generateNonce());
  const sessionId = `sbx_relay_reconnect_${suffix}_${Date.now().toString(36)}`;
  const paymentKey = "e".repeat(64);
  const claim = await store.claimPaymentIntent(paymentKey, `relay-reconnect-${suffix}`, 30_000);
  if (claim.status !== "claimed") throw new Error(`could not claim payment: ${claim.status}`);
  await store.completeEntitlement(
    paymentKey,
    claim.token,
    paymentRecord(paymentKey),
    sessionRecord(sessionId, paymentKey, toBase64(clientKeys.publicKey), clientNonce, durationSeconds),
  );

  reconciler.start();

  const ready = await waitFor(
    () => store.getSession(sessionId),
    (session) => session?.state === "READY" && Boolean(session.podName),
    "session READY",
  );

  const run: Run = {
    store,
    sessionId,
    workDir,
    workspaceFile: join(workDir, "sandboxes", sessionId, "workspace", "persisted.txt"),
    relay,
    relayPort,
    relayClient,
    provisioner,
    reconciler,
    control,
    clientKeys,
    clientNonce,
    guestPublicKey: ready!.guestPublicKey!,
    leaseExpiresAt: ready!.leaseExpiresAt!,
    podName: ready!.podName!,
    restartRelay: async () => {
      // A process kill, not a graceful drain: destroy every socket (the guest
      // sees a broken link, which is what a SIGKILL looks like) and stop the
      // listener, then serve the same address from a new process with a new
      // generation. Waiting for a WebSocket close handshake here would depend
      // on a guest that is mid-command.
      relay.server.closeAllConnections();
      await relay.close();
      relay = await startRelay(relayPort);
      run.relay = relay;
    },
    cleanup: async () => {
      reconciler.stop();
      await sleep(100);
      provisioner.signalPod(run.podName, "SIGCONT");
      for (const pod of await provisioner.listSandboxPods().catch(() => [])) {
        await provisioner.deletePod(pod.name).catch(() => undefined);
      }
      await close(control).catch(() => undefined);
      await store.close();
      await relay.close();
      await rm(workDir, { recursive: true, force: true });
    },
  };
  return run;
}

const active: Run[] = [];

afterEach(async () => {
  for (const run of active.splice(0)) await run.cleanup().catch(() => undefined);
});

/** Seal an operation to the session's guest key and send it through the relay. */
async function forward(
  run: Run,
  requestId: string,
  payload: Record<string, unknown>,
  epoch: number,
): Promise<void> {
  const envelope = await sealJsonTo(fromBase64(run.guestPublicKey), {
    v: 2,
    sessionId: run.sessionId,
    clientNonce: run.clientNonce,
    requestId,
    ...payload,
  });
  await run.relayClient.request(run.sessionId, requestId, envelope, Date.now() + 120_000, epoch);
}

async function awaitResult(run: Run, requestId: string) {
  const response = await run.relayClient.response(run.sessionId, requestId, 30_000);
  if (response.kind !== "envelope") throw new Error(`no result: ${JSON.stringify(response)}`);
  return openSealedJson<{ ok: boolean; stdout: string }>(
    response.envelope,
    run.clientKeys.publicKey,
    run.clientKeys.privateKey,
  );
}

async function waitForGuestState(
  run: Run,
  predicate: (state: Awaited<ReturnType<RelayClient["state"]>>) => boolean,
  label: string,
): Promise<Awaited<ReturnType<RelayClient["state"]>>> {
  return waitFor(() => run.relayClient.state(run.sessionId), predicate, label, 30_000);
}

describe("a relay restart does not kill a paid session", () => {
  it("fences the in-flight exec as outcome_unknown and keeps the session READY", async () => {
    const run = await scenario(30_000, "survive");
    active.push(run);

    // A workspace file the customer wrote before the restart.
    await forward(run, "relay-reconnect-put-01", {
      op: "file.put",
      path: "persisted.txt",
      dataBase64: Buffer.from("survives the relay\n").toString("base64"),
      mode: 0o644,
    }, 1);
    const put = await awaitResult(run, "relay-reconnect-put-01");
    expect(put.ok).toBe(true);
    expect(existsSync(run.workspaceFile)).toBe(true);

    // The operation that is in flight when the relay dies.
    const oldRequestId = "relay-reconnect-exec-01";
    const oldClaim = await run.store.claimOperation(run.sessionId, oldRequestId, "exec");
    expect(oldClaim).toMatchObject({ ok: true, epoch: 1 });
    await forward(run, oldRequestId, {
      op: "exec",
      command: ["sh", "-c", "sleep 60; printf late > /workspace/late.txt"],
      timeoutMs: 90_000,
    }, 1);
    await waitForGuestState(run, (state) => state.activeRequestId === oldRequestId, "exec in flight");

    const before = (await run.store.getSession(run.sessionId))!;
    expect(before.leaseExpiresAt).toBe(run.leaseExpiresAt);

    await run.restartRelay();

    // The controller fences the interrupted request exactly once: outcome
    // unknown, a higher execution epoch, and the gate still held.
    const fenced = await waitFor(
      () => run.store.getExecRequest(run.sessionId, oldRequestId),
      (record) => record?.state === "outcome_unknown",
      "request fenced as outcome_unknown",
    );
    expect(fenced!.resultEnvelope).toBeNull();
    const bumped = await waitFor(
      () => run.store.getSession(run.sessionId),
      (session) => (session?.execEpoch ?? 0) >= 2,
      "execution epoch bumped",
    );
    expect(bumped!.execEpoch).toBe(2);
    // The session is never terminal for this: READY/ACTIVE survives, the lease
    // is untouched.
    expect(["READY", "ACTIVE"]).toContain(bumped!.state);
    expect(bumped!.leaseExpiresAt).toBe(run.leaseExpiresAt);

    // The guest reconnects to the replacement relay and reports idle, which is
    // what releases the gate.
    await waitForGuestState(run, (state) => state.connected && state.statusAt !== undefined, "guest reconnected");
    const cleared = await waitFor(
      () => run.store.getSession(run.sessionId),
      (session) => session?.activeRequestId === null,
      "fence cleared after reconnect",
    );
    expect(cleared!.state).toBe("READY");
    expect(cleared!.leaseExpiresAt).toBe(run.leaseExpiresAt);

    // A retry of the interrupted request is a defined outcome, never a
    // duplicate execution: 409 outcome_unknown from the controller.
    const retry = await fetch(`http://127.0.0.1:${testPort(18893)}/internal/sessions/${run.sessionId}/operations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": ADMIN },
      body: JSON.stringify({ requestId: oldRequestId, envelope: "sealed-retry", op: "exec" }),
    });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: "outcome_unknown", requestId: oldRequestId });

    // The workspace survived and a new operation runs on the new epoch, through
    // the same control API a client uses.
    const newRequestId = "relay-reconnect-exec-02";
    const newEnvelope = await sealJsonTo(fromBase64(run.guestPublicKey), {
      v: 2,
      sessionId: run.sessionId,
      clientNonce: run.clientNonce,
      requestId: newRequestId,
      op: "exec",
      // `cwd` is the workspace; local mode runs the guest on the host, so an
      // absolute /workspace path would not be the sandbox's.
      command: ["cat", "persisted.txt"],
      timeoutMs: 10_000,
    });
    const accepted = await fetch(
      `http://127.0.0.1:${testPort(18893)}/internal/sessions/${run.sessionId}/operations`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": ADMIN },
        body: JSON.stringify({ requestId: newRequestId, envelope: newEnvelope, op: "exec" }),
      },
    );
    expect(accepted.status).toBe(200);
    const acceptedBody = (await accepted.json()) as { envelope?: string };
    const result = await openSealedJson<{ ok: boolean; stdout: string }>(
      String(acceptedBody.envelope),
      run.clientKeys.publicKey,
      run.clientKeys.privateKey,
    );
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("survives the relay\n");
    expect(await run.store.getExecRequest(run.sessionId, newRequestId)).toMatchObject({
      state: "done",
      epoch: 2,
    });

    // The interrupted command was aborted, not re-executed and not restarted:
    // its marker file never appears.
    expect(existsSync(join(run.workDir, "sandboxes", run.sessionId, "workspace", "late.txt"))).toBe(false);
    expect((await run.store.getExecRequest(run.sessionId, oldRequestId))?.resultEnvelope).toBeNull();
  }, 120_000);

  it("ends the session with relay_lost when the guest cannot reconnect inside the grace", async () => {
    const run = await scenario(2_000, "lost");
    active.push(run);

    // Freeze the guest: it cannot dial the replacement relay.
    expect(run.provisioner.signalPod(run.podName, "SIGSTOP")).toBe(true);
    await run.restartRelay();

    const terminal = await waitFor(
      () => run.store.getSession(run.sessionId),
      (session) => ["FAILED", "EXPIRED", "DESTROYED"].includes(session?.state ?? ""),
      "session terminal after the relay grace",
      30_000,
    );
    expect(terminal!.state).toBe("FAILED");
    expect(terminal!.terminationReason).toBe("failure:relay_lost");
    expect(terminal!.failureCode).toBe("relay_lost");
    // It delivered service (READY), so the refund policy, not this path, decides
    // compensation. The reason is the contract this test owns.
    expect(terminal!.readyAt).not.toBeNull();
  }, 60_000);

  it("keeps relay_lost inside a short lease, before the lease check, and refunds it", async () => {
    // 5s lease, 60s grace: without the lease bound the lease would expire first
    // and the session would end `lease_expired`, which the refund policy does
    // not compensate even though the relay loss caused the interruption.
    const run = await scenario(60_000, "shortlease", { leaseSeconds: 5 });
    active.push(run);

    expect(run.provisioner.signalPod(run.podName, "SIGSTOP")).toBe(true);
    await run.restartRelay();

    const terminal = await waitFor(
      () => run.store.getSession(run.sessionId),
      (session) => ["FAILED", "EXPIRED", "DESTROYED"].includes(session?.state ?? ""),
      "short-lease session terminal",
      30_000,
    );
    expect(terminal!.state).toBe("FAILED");
    // The reason, not the lease, is what the refund policy keys on.
    expect(terminal!.terminationReason).toBe("failure:relay_lost");
    expect(terminal!.failureCode).toBe("relay_lost");
    expect(terminal!.readyAt).not.toBeNull();

    // The policy is on main now, so assert the real ledger, not the reason.
    const ledger = await waitFor(
      () => run.store.getLedgerBySession(run.sessionId),
      (entry) => entry?.status === "REFUNDED",
      "ledger refunded",
      15_000,
    );
    expect(ledger!.status).toBe("REFUNDED");
    expect(ledger!.refundTransaction ?? "").toMatch(/^mock:refund:/);
  }, 60_000);
});
