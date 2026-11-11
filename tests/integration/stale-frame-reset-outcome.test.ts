/**
 * Lifecycle outcome of a withdrawn stale frame (#88).
 *
 * The relay closes the stale-frame window by resetting a guest that has not
 * observed the newest recovery epoch. A reset ends the guest supervisor exactly
 * like any other relay-link loss, so the session must not be left `READY` with
 * no guest. This test drives the real reconciler (LocalProvisioner + Capacity +
 * OperationFence + Termination) and asserts the documented outcome:
 *
 *   READY -> fence withdraws the frame and resets the link (no guest)
 *         -> guest process exits (restartPolicy: Never)
 *         -> reconciler observes the terminal Pod, fails the session
 *         -> FAILED, reason `failure:guest_exited`
 *
 * The payment is not refunded because the session had already reached READY
 * (RefundOnlyWhenNoService). See docs/adr/0008-relay-enforces-execution-epoch.md.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fromBase64,
  generateBoxKeyPair,
  generateNonce,
  sealJsonTo,
  toBase64,
} from "@x402s/shared/crypto";
import type { SessionLimits } from "@x402s/shared/protocol";
import { MetricsRegistry } from "@x402s/shared/runtime";
import { loadControllerConfig } from "../../controller/src/config.js";
import { CapacityService } from "../../controller/src/capacity/service.js";
import { createRelay, type RelayServer } from "../../controller/src/relay.js";
import { RelayClient } from "../../controller/src/relay-client.js";
import { Reconciler } from "../../controller/src/reconciler.js";
import { OperationFence } from "../../controller/src/operation-fence.js";
import {
  Store,
  type PaymentRecord,
  type SessionRecord,
} from "../../controller/src/store.js";
import { LocalProvisioner } from "../../controller/src/local-provisioner.js";

const RELAY_ADMIN = "r".repeat(24);
const ADMIN = "stale-frame-reset-admin-0123456789";
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

/** Which branch of the relay's resetConnection ran (see controller/src/relay/registry.ts). */
function resetCounts(registry: MetricsRegistry): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of registry.render().split("\n")) {
    const match = /^sandbox_relay_connection_resets_total\{mode="([^"]+)"\} (\d+)$/.exec(line);
    if (match) counts[match[1]!] = Number(match[2]);
  }
  return counts;
}

interface Run {
  store: Store;
  sessionId: string;
  workDir: string;
  markerPath: string;
  relay: RelayServer;
  relayClient: RelayClient;
  provisioner: LocalProvisioner;
  reconciler: Reconciler;
  clientKeys: Awaited<ReturnType<typeof generateBoxKeyPair>>;
  /** Relay metrics for this run, so the reset branch can be asserted. */
  relayMetrics: MetricsRegistry;
  /** Set by the test once the reconciler has named the Pod. */
  podName?: string;
  cleanup(): Promise<void>;
}

async function scenario(): Promise<Run> {
  const workDir = mkdtempSync(join(tmpdir(), "x402-stale-reset-"));
  // A per-run registry: the counter that distinguishes a TCP reset from the
  // ws.terminate() fallback must not be shared with another test in the worker.
  const relayMetrics = new MetricsRegistry({ cacheMs: 0 });
  const relay = createRelay({ adminToken: RELAY_ADMIN, responseTtlMs: 60_000, metricsRegistry: relayMetrics });
  await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  const relayPort = (relay.server.address() as { port: number }).port;

  const store = new Store(join(workDir, "controller.db"));
  const cfg = loadControllerConfig({
    ADMIN_TOKEN: ADMIN,
    ROLE: "controller",
    KUBERNETES_ENABLED: "false",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    DB_PATH: join(workDir, "controller.db"),
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
  const relayClient = new RelayClient({ baseUrl: `http://127.0.0.1:${relayPort}`, adminToken: RELAY_ADMIN, timeoutMs: 1_000 });
  const fence = new OperationFence(store, relayClient);
  const reconciler = new Reconciler({ cfg, store, provisioner, relay: relayClient, capacity, fence });

  const clientKeys = await generateBoxKeyPair();
  const clientNonce = toBase64(await generateNonce());
  const sessionId = `sbx_stale_reset_${Date.now().toString(36)}`;
  const paymentKey = "e".repeat(64);
  const claim = store.claimPaymentIntent(paymentKey, "stale-frame-reset", 30_000);
  if (claim.status !== "claimed") throw new Error(`could not claim payment: ${claim.status}`);
  store.completeEntitlement(
    paymentKey,
    claim.token,
    paymentRecord(paymentKey),
    sessionRecord(sessionId, paymentKey, toBase64(clientKeys.publicKey), clientNonce),
  );

  reconciler.start();

  const run: Run = {
    store,
    sessionId,
    workDir,
    markerPath: join(tmpdir(), `x402-stale-reset-marker-${sessionId}`),
    relay,
    relayClient,
    provisioner,
    reconciler,
    clientKeys,
    relayMetrics,
    cleanup: async () => {
      reconciler.stop();
      // A stopped process does not act on SIGKILL until it is continued.
      if (run.podName) provisioner.signalPod(run.podName, "SIGCONT");
      for (const pod of await provisioner.listSandboxPods().catch(() => [])) {
        await provisioner.deletePod(pod.name).catch(() => undefined);
      }
      store.close();
      await relay.close();
      rmSync(run.markerPath, { force: true });
      await rm(workDir, { recursive: true, force: true });
    },
  };
  return run;
}

const active: Run[] = [];

afterEach(async () => {
  for (const run of active.splice(0)) await run.cleanup().catch(() => undefined);
});

describe("a withdrawn stale frame does not strand a READY session", () => {
  it("resets the guest, then the reconciler fails the session with guest_exited", async () => {
    const run = await scenario();
    active.push(run);

    const ready = await waitFor(
      () => run.store.getSession(run.sessionId),
      (session) => session?.state === "READY" && Boolean(session.podName),
      "session READY",
    );
    const podName = ready!.podName!;
    run.podName = podName;
    expect(ready!.guestPublicKey).toBeTruthy();

    const oldRequestId = "stale-reset-old-request";
    const claim = run.store.claimOperation(run.sessionId, oldRequestId, "exec");
    expect(claim).toMatchObject({ ok: true, epoch: 1 });

    const envelope = await sealJsonTo(fromBase64(ready!.guestPublicKey!), {
      v: 2,
      sessionId: run.sessionId,
      clientNonce: ready!.clientNonce,
      requestId: oldRequestId,
      op: "exec",
      command: ["sh", "-c", `printf ran > ${run.markerPath}`],
      timeoutMs: 60_000,
    });

    // Freeze the guest so the frame stays in its socket queue: "forwarded by the
    // previous generation, not yet observed".
    expect(run.provisioner.signalPod(podName, "SIGSTOP")).toBe(true);
    await sleep(100);
    await run.relayClient.request(run.sessionId, oldRequestId, envelope, Date.now() + 120_000, 1);
    expect((await run.relayClient.state(run.sessionId)).pending).toBe(1);

    // The controller restarts: the interrupted request becomes outcome_unknown
    // and the session epoch is bumped. Housekeeping then reconciles the fence.
    expect(run.store.recoverInterruptedOperations()).toEqual({ requests: 1, sessions: 1 });
    expect(run.store.getSession(run.sessionId)).toMatchObject({
      activeRequestId: oldRequestId,
      execEpoch: 2,
    });

    // The fence publishes epoch 2, the relay withdraws the frame and resets the
    // guest link. The gate clears because no command can survive that link.
    await waitFor(
      () => run.store.getSession(run.sessionId),
      (session) => session?.activeRequestId === null,
      "fence cleared after reset",
    );
    const afterReset = await run.relayClient.state(run.sessionId);
    expect(afterReset).toMatchObject({ connected: false, pending: 0, epochFloor: 2 });
    // The guarantee depends on *which* branch ended the link: a TCP reset
    // discards unread bytes, while ws.terminate() is a close ordered after the
    // queued frame, so the withdrawn frame could still be read. Assert the
    // reset ran, so a CI failure at the marker assertion below has one cause:
    // the guest read the frame before the reset (the ADR residual), not a
    // degraded close.
    expect(resetCounts(run.relayMetrics)).toEqual({ tcp_reset: 1 });
    expect(run.store.getSession(run.sessionId)?.state).toBe("READY");

    // Resume the process so it observes the reset and exits, exactly as an
    // unstoppable production guest would.
    expect(run.provisioner.signalPod(podName, "SIGCONT")).toBe(true);
    const pod = await waitFor(
      () => run.provisioner.getPod(podName),
      (value) => value === null || value.phase === "Succeeded" || value.phase === "Failed",
      "guest process exit",
    );
    expect(pod === null || pod.phase === "Succeeded" || pod.phase === "Failed").toBe(true);

    // The guest never read the withdrawn frame.
    expect(existsSync(run.markerPath)).toBe(false);

    // The reconciler must not leave a READY session with no guest: it observes
    // the terminal Pod (restartPolicy: Never) and fails the session with the
    // documented reason.
    const terminal = await waitFor(
      () => run.store.getSession(run.sessionId),
      (session) => session?.state === "FAILED" || session?.state === "EXPIRED" || session?.state === "DESTROYED",
      "session terminal",
      30_000,
    );
    expect(terminal!.state).toBe("FAILED");
    expect(terminal!.terminationReason).toBe("failure:guest_exited");
    expect(terminal!.failureCode).toBe("guest_exited");
    expect(terminal!.activeRequestId).toBeNull();
    expect(terminal!.podName).toBeNull();

    // The session reached READY, so it delivered service and is not refunded;
    // the ledger stays settled (RefundOnlyWhenNoService).
    expect(run.store.getLedgerBySession(run.sessionId)?.status).toBe("SETTLED");
  }, 90_000);
});
