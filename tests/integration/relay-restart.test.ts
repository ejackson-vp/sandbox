/**
 * Relay restart during a paid create (#17), against the real guest process.
 *
 * The relay registry is in memory and the Deployment replaces the pod
 * (maxSurge: 0). The local simulation uses a TCP router in front of two real
 * relays: existing connections stay pinned to the old relay exactly like a
 * kube-proxy DNAT entry, while new connections reach the replacement.
 *
 * Two outcomes are covered:
 *   - the replacement relay learns the registration and the create reaches
 *     READY (the controller re-registers without waiting for the next tick);
 *   - the relay never comes back, so the create fails inside the provisioning
 *     budget and the settled payment is refunded.
 *
 * Neither path may leave a charged session with `pod_terminated`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fromBase64,
  openSealedJson,
  sealJsonTo,
  generateBoxKeyPair,
  generateNonce,
  toBase64,
} from "@x402s/shared/crypto";
import { loadControllerConfig } from "../../controller/src/config.js";
import { CapacityService } from "../../controller/src/capacity/service.js";
import { createRelay, type RelayServer } from "../../controller/src/relay.js";
import { RelayClient } from "../../controller/src/relay-client.js";
import { Reconciler } from "../../controller/src/reconciler.js";
import {
  Store,
  type PaymentRecord,
  type SessionLimits,
  type SessionRecord,
} from "../../controller/src/store.js";
import { LocalProvisioner } from "../../controller/src/local-provisioner.js";
import type { SandboxPodSpec } from "../../controller/src/k8s.js";
import { TcpRouter } from "../helpers/tcp-router.js";

const RELAY_ADMIN = "r".repeat(24);
const ADMIN = "relay-restart-admin-token-0123456789";
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

class HookProvisioner extends LocalProvisioner {
  /** Runs after relay registration and before the guest process is spawned. */
  beforeCreate?: () => void;

  override async createPod(spec: SandboxPodSpec): Promise<{ podName: string }> {
    this.beforeCreate?.();
    return super.createPod(spec);
  }
}

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

async function listen(relay: RelayServer): Promise<number> {
  await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", () => resolve()));
  return (relay.server.address() as { port: number }).port;
}

async function waitFor(
  store: Store,
  sessionId: string,
  predicate: (session: SessionRecord) => boolean,
  timeoutMs = 30_000,
): Promise<SessionRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = store.getSession(sessionId);
    if (session && predicate(session)) return session;
    if (Date.now() >= deadline) {
      throw new Error(`timed out; last session ${JSON.stringify(session)}`);
    }
    await sleep(50);
  }
}

interface Scenario {
  store: Store;
  sessionId: string;
  workDir: string;
  relayA: RelayServer;
  relayB: RelayServer;
  router: TcpRouter;
  provisioner: HookProvisioner;
  reconciler: Reconciler;
  clientKeys: Awaited<ReturnType<typeof generateBoxKeyPair>>;
  cleanup(): Promise<void>;
}

async function scenario(mode: "ready" | "refund"): Promise<Scenario> {
  const workDir = mkdtempSync(join(tmpdir(), `x402-relay-restart-${mode}-`));
  const relayA = createRelay({ adminToken: RELAY_ADMIN, responseTtlMs: 60_000 });
  const relayB = createRelay({ adminToken: RELAY_ADMIN, responseTtlMs: 60_000 });
  const portA = await listen(relayA);
  const portB = await listen(relayB);
  const router = new TcpRouter();
  router.setUpstream(portA);
  const routerPort = await router.listen();

  // A port with no listener stands in for a relay whose replacement never
  // becomes ready.
  const deadPort = await freePort();

  const store = new Store(join(workDir, "controller.db"));
  const cfg = loadControllerConfig({
    ADMIN_TOKEN: ADMIN,
    ROLE: "controller",
    KUBERNETES_ENABLED: "false",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    DB_PATH: join(workDir, "controller.db"),
    RELAY_URL: `http://127.0.0.1:${routerPort}`,
    RELAY_SERVICE_NAME: "relay",
    PROXY_SERVICE_NAME: "egress-proxy",
    RELAY_ADMIN_TOKEN: RELAY_ADMIN,
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
    GUEST_IMAGE: "x402-sandbox/guest:dev",
    RECONCILE_INTERVAL_MS: "100",
    // Keep the test under a minute; the production default is 90s and the
    // guest's dial window (150s) is deliberately longer than either.
    PROVISIONING_TIMEOUT_MS: "10000",
    RELAY_REGISTRATION_TIMEOUT_MS: "3000",
    ALLOW_CUSTOM_DURATIONS: "true",
  });

  const provisioner = new HookProvisioner({
    binary: GUEST_BINARY,
    relayHost: "127.0.0.1",
    relayPort: routerPort,
    proxyHost: "127.0.0.1",
    proxyPort: 3128,
    workRoot: join(workDir, "sandboxes"),
  });
  provisioner.beforeCreate = () => {
    // The controller has registered on A by now. New connections (the guest
    // dial, and the controller's next probe) reach B; sockets already open
    // stay pinned to A, which is what a terminating pod looks like.
    router.setUpstream(mode === "ready" ? portB : deadPort);
  };

  const capacity = new CapacityService({ cfg, store, provisioner });
  const relay = new RelayClient({
    baseUrl: `http://127.0.0.1:${routerPort}`,
    adminToken: RELAY_ADMIN,
    timeoutMs: 1_000,
  });
  const reconciler = new Reconciler({ cfg, store, provisioner, relay, capacity });

  const keys = await generateBoxKeyPair();
  const nonce = toBase64(await generateNonce());
  const sessionId = `sbx_relay_restart_${mode}_${Date.now().toString(36)}`;
  const paymentKey = `${mode}`.padEnd(64, "0");
  const claim = store.claimPaymentIntent(paymentKey, `relay-restart-${mode}`, 30_000);
  if (claim.status !== "claimed") throw new Error(`could not claim ${paymentKey}: ${claim.status}`);
  store.completeEntitlement(
    paymentKey,
    claim.token,
    paymentRecord(paymentKey),
    sessionRecord(sessionId, paymentKey, toBase64(keys.publicKey), nonce),
  );

  reconciler.start();

  return {
    store,
    sessionId,
    workDir,
    relayA,
    relayB,
    router,
    provisioner,
    reconciler,
    clientKeys: keys,
    cleanup: async () => {
      reconciler.stop();
      for (const pod of await provisioner.listSandboxPods().catch(() => [])) {
        await provisioner.deletePod(pod.name).catch(() => undefined);
      }
      store.close();
      await router.close();
      await relayA.close();
      await relayB.close();
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

function assertNotChargedPodTerminated(store: Store, sessionId: string): void {
  const session = store.getSession(sessionId);
  const ledger = store.getLedgerBySession(sessionId);
  const chargedPodTerminated =
    session?.failureCode === "pod_terminated" && ledger?.status === "SETTLED";
  expect(chargedPodTerminated).toBe(false);
}

const active: Scenario[] = [];

afterEach(async () => {
  for (const run of active.splice(0)) await run.cleanup().catch(() => undefined);
});

describe("relay restart during a paid create", () => {
  it("reaches READY after the replacement relay takes over", async () => {
    const run = await scenario("ready");
    active.push(run);

    const ready = await waitFor(run.store, run.sessionId, (session) => session.state === "READY");
    expect(ready.readyAt).not.toBeNull();
    expect(ready.podName).toBeTruthy();
    expect(ready.failureCode).toBeNull();

    // The registration and the guest are on the replacement generation, and
    // the session is actually usable (not just marked READY).
    const relayB = new RelayClient({
      baseUrl: `http://127.0.0.1:${(run.relayB.server.address() as { port: number }).port}`,
      adminToken: RELAY_ADMIN,
    });
    const onB = await relayB.state(run.sessionId);
    expect(onB.connected).toBe(true);
    expect(onB.attestation?.sessionId).toBe(run.sessionId);

    const requestId = "relay-restart-exec-1";
    const envelope = await sealJsonTo(fromBase64(ready.guestPublicKey ?? ""), {
      v: 2,
      sessionId: run.sessionId,
      clientNonce: ready.clientNonce,
      requestId,
      op: "exec",
      command: ["echo", "relay-restart-ok"],
      timeoutMs: 5_000,
    });
    await relayB.request(run.sessionId, requestId, envelope, Date.now() + 30_000);
    const response = await relayB.response(run.sessionId, requestId, 15_000);
    expect(response.kind).toBe("envelope");
    if (response.kind === "envelope") {
      const result = await openSealedJson<{ ok: boolean; stdout: string }>(
        response.envelope,
        run.clientKeys.publicKey,
        run.clientKeys.privateKey,
      );
      expect(result.ok).toBe(true);
      expect(result.stdout.trim()).toBe("relay-restart-ok");
    }

    expect(run.store.getLedgerBySession(run.sessionId)?.status).toBe("SETTLED");
    assertNotChargedPodTerminated(run.store, run.sessionId);
  }, 60_000);

  it("refunds cleanly when the relay never comes back", async () => {
    const run = await scenario("refund");
    active.push(run);

    const failed = await waitFor(
      run.store,
      run.sessionId,
      (session) => session.state === "FAILED" || session.state === "EXPIRED",
      40_000,
    );
    expect(failed.state).toBe("FAILED");
    expect(failed.failureCode).toBe("provisioning_timeout");
    expect(failed.readyAt).toBeNull();

    const ledger = run.store.getLedgerBySession(run.sessionId);
    expect(ledger?.status).toBe("REFUNDED");
    assertNotChargedPodTerminated(run.store, run.sessionId);
  }, 90_000);
});
