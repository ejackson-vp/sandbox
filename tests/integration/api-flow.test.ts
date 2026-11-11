/**
 * End-to-end control-plane test: real x402 handshake, real controller/store/
 * relay/reconciler, real guest process (LocalProvisioner) and the real SDK.
 * Only Kubernetes pod creation is substituted; tests/security covers the real
 * cluster.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import {
  createMockFacilitator,
  type MockFacilitatorHandle,
} from "../../api/src/mock-facilitator.js";
import { createApp } from "../../api/src/server.js";
import { loadConfig } from "../../api/src/config.js";
import { ControllerClient, ControllerError } from "../../api/src/controller-client.js";
import { createControlApi } from "../../controller/src/control-api.js";
import { createRelay, type RelayServer } from "../../controller/src/relay.js";
import { RelayClient } from "../../controller/src/relay-client.js";
import { Reconciler } from "../../controller/src/reconciler.js";
import { Store } from "../../controller/src/store.js";
import type { SessionRecord } from "../../controller/src/store.js";
import type { Snapshotter } from "../../controller/src/snapshotter.js";
import { LocalProvisioner } from "../../controller/src/local-provisioner.js";
import { CapacityService } from "../../controller/src/capacity/service.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import { hostPathEnv } from "./dev-path.js";
import {
  clientCommitmentMessage,
  fromBase64,
  generateBoxKeyPair,
  generateNonce,
  toBase64,
} from "../../shared/src/entries/crypto.js";
import { paymentKey } from "../../shared/src/entries/payment.js";
import { type SessionStatus } from "../../shared/src/entries/protocol.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  SandboxClient,
  FileSessionStore,
  SandboxError,
  type SessionHandle,
} from "../../sdk/src/index.js";
import { createSessionPayment, requestChallenge } from "../helpers/x402.js";
import { makeTar } from "../helpers/tar.js";
import { testPort } from "./ports.js";

const API_PORT = testPort(13300);
const FACILITATOR_PORT = testPort(13302);
const CONTROLLER_PORT = testPort(13301);
const RELAY_PORT = testPort(18455);
const ADMIN = "integration-admin-token-0123456789";
const RELAY_ADMIN = "r".repeat(24);
const WAKE = "w".repeat(24);
const DEV_SEED = "qSgP+dPwGhb/58O0ZD/dSqCMovhhWNIQbT3MeTD35WY=";
const GUEST_BINARY = process.env.GUEST_BINARY ?? join(process.cwd(), "guest/bin/x402-guest");
const apiUrl = `http://127.0.0.1:${API_PORT}`;

let facilitator: MockFacilitatorHandle;
let relay: RelayServer;
let store: Store;
let reconciler: Reconciler;
let servers: http.Server[] = [];
let workDir: string;
let client: SandboxClient;
let snapshotter: RecordingSnapshotter;
let apiController: ControllerClient;
let provisioner: LocalProvisioner;
let capacity: CapacityService;

class RecordingSnapshotter implements Snapshotter {
  readonly captured: string[] = [];
  readonly restored: string[] = [];
  readonly discarded: string[] = [];

  async capture(session: SessionRecord): Promise<void> {
    this.captured.push(session.id);
  }
  async restore(session: SessionRecord): Promise<void> {
    this.restored.push(session.id);
  }
  async discard(session: SessionRecord): Promise<void> {
    this.discarded.push(session.id);
  }
}

function listen(app: http.RequestListener | http.Server, port: number): Promise<http.Server> {
  const server = http.createServer(app as http.RequestListener);
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollStatus(handle: { sessionId: string; capability: string }, until: (s: SessionStatus) => boolean, timeoutMs = 45_000): Promise<SessionStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: SessionStatus | undefined;
  while (Date.now() < deadline) {
    const res = await fetch(`${apiUrl}/v1/sessions/${handle.sessionId}`, {
      headers: { "x-sandbox-capability": handle.capability },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    last = (await res.json()) as SessionStatus;
    if (until(last)) return last;
    await sleep(150);
  }
  throw new Error(`timeout; last state ${last?.state}`);
}

async function postSession(body: unknown, header?: string): Promise<Response> {
  return fetch(`${apiUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(header ? { "PAYMENT-SIGNATURE": header } : {}) },
    body: JSON.stringify(body),
  });
}

function createBody(overrides: Record<string, unknown> = {}) {
  return findKeys().then((keys) => ({
    tier: "custom",
    durationSeconds: 60,
    clientPublicKey: keys.publicKey,
    clientNonce: keys.nonce,
    ...overrides,
  }));
}

async function findKeys() {
  const keys = await generateBoxKeyPair();
  return { publicKey: toBase64(keys.publicKey), nonce: toBase64(await generateNonce()) };
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "x402-session-it-"));
  facilitator = await createMockFacilitator({ dbPath: join(workDir, "facilitator.db") });
  servers.push(await listen(facilitator.app, FACILITATOR_PORT));

  relay = createRelay({ adminToken: RELAY_ADMIN, responseTtlMs: 120_000 });
  await new Promise<void>((r) => relay.server.listen(RELAY_PORT, "127.0.0.1", () => r()));

  const relayClient = new RelayClient({ baseUrl: `http://127.0.0.1:${RELAY_PORT}`, adminToken: RELAY_ADMIN });
  store = new Store(join(workDir, "controller.db"));

  const controllerCfg = loadControllerConfig({
    ADMIN_TOKEN: ADMIN,
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DB_PATH: join(workDir, "controller.db"),
    RELAY_URL: `http://127.0.0.1:${RELAY_PORT}`,
    RELAY_ADMIN_TOKEN: RELAY_ADMIN,
    WAKE_TOKEN: WAKE,
    PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
    GUEST_IMAGE: "x402-sandbox/guest:dev",
    RECONCILE_INTERVAL_MS: "100",
    RELAY_RESPONSE_WAIT_MS: "30000",
    ALLOW_CUSTOM_DURATIONS: "true",
  });

  provisioner = new LocalProvisioner({
    binary: GUEST_BINARY,
    relayHost: "127.0.0.1",
    relayPort: RELAY_PORT,
    proxyHost: "127.0.0.1",
    proxyPort: 3128,
    workRoot: join(workDir, "sandboxes"),
  });

  capacity = new CapacityService({ cfg: controllerCfg, store, provisioner });

  let suspendFn: ((id: string) => Promise<void>) | undefined;
  let resumeFn: ((id: string) => Promise<void>) | undefined;
  servers.push(
    await listen(
      createControlApi({
        cfg: controllerCfg,
        store,
        relay: relayClient,
        provisioner,
        capacity,
        suspend: (id) => {
          if (!suspendFn) return Promise.reject(new Error("reconciler not started"));
          return suspendFn(id);
        },
        resume: (id) => {
          if (!resumeFn) return Promise.reject(new Error("reconciler not started"));
          return resumeFn(id);
        },
      }),
      CONTROLLER_PORT,
    ),
  );
  snapshotter = new RecordingSnapshotter();
  reconciler = new Reconciler({
    cfg: controllerCfg,
    store,
    provisioner,
    relay: relayClient,
    capacity,
    snapshotter,
  });
  suspendFn = (id) => reconciler.suspendSession(id);
  resumeFn = (id) => reconciler.resumeSession(id);
  reconciler.start();

  const apiCfg = loadConfig({
    PORT: String(API_PORT),
    PAYMENT_MODE: "mock",
    FACILITATOR_URL: `http://127.0.0.1:${FACILITATOR_PORT}`,
    CONTROLLER_URL: `http://127.0.0.1:${CONTROLLER_PORT}`,
    CONTROLLER_ADMIN_TOKEN: ADMIN,
    CAPABILITY_SECRET: "capability-secret-0123456789",
    PUBLIC_BASE_URL: apiUrl,
    ALLOW_INSECURE_DEV: "true",
    PAYMENT_INTENT_STALE_MS: "1000",
    ALLOW_CUSTOM_DURATIONS: "true",
  });
  apiController = new ControllerClient(apiCfg.controllerUrl, ADMIN);
  servers.push(await listen(await createApp({ config: apiCfg, controller: apiController }), API_PORT));

  process.env.DEV_ATTESTATION_KEY = DEV_SEED;
  process.env.DEV_ATTESTATION_KEY_ID = "x402-dev-attestation-key-INSECURE-DEV-ONLY";

  client = new SandboxClient({
    apiUrl,
    paymentMode: "mock",
    allowInsecureDev: true,
    store: new FileSessionStore(join(workDir, "sessions")),
  });
});

afterAll(async () => {
  reconciler?.stop();
  await relay?.close();
  for (const s of servers) await close(s).catch(() => undefined);
  facilitator?.close();
  store?.close();
  await rm(workDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readiness", () => {
  it("reports ready for the API and controller before serving creates", async () => {
    const apiReady = await fetch(`${apiUrl}/readyz`);
    expect(apiReady.status).toBe(200);
    expect(await apiReady.json()).toMatchObject({ ok: true, components: { controller: { ok: true } } });

    const controllerReady = await fetch(`http://127.0.0.1:${CONTROLLER_PORT}/internal/readyz`);
    expect(controllerReady.status).toBe(200);
    const body = (await controllerReady.json()) as {
      ok: boolean;
      components: Record<string, { ok: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(body.components.store).toMatchObject({ ok: true });
    expect(body.components.relay).toMatchObject({ ok: true });
    expect(body.components.provisioner).toMatchObject({ ok: true });
  });
});

describe("payments and entitlements", () => {
  it("returns a 402 challenge priced per tier", async () => {
    const body = await createBody({ tier: "extended", durationSeconds: undefined });
    const res = await postSession(body);
    expect(res.status).toBe(402);
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0].amount).toBe("100000"); // $0.10
    expect(decoded.accepts[0].network).toBe("mock:local");
    expect(store.countSessions()).toBe(0);
  });

  it("rejects a tampered payment", async () => {
    const body = await createBody();
    const { header, body: signedBody } = await createSessionPayment(apiUrl, body);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    decoded.payload.authorization.value = "1";
    const tampered = Buffer.from(JSON.stringify(decoded)).toString("base64");
    const res = await postSession(signedBody, tampered);
    // Tampering changes the payment key, so the wallet's commitment signature
    // no longer covers this receipt. Rejected before any settlement.
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("client_proof_invalid");
    expect(store.countSessions()).toBe(0);
  });

  it("rejects plaintext command fields", async () => {
    const res = await fetch(`${apiUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(await createBody()), command: ["echo", "hi"] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("plaintext_not_accepted");
  });

  it("rejects a duration that does not match a fixed tier", async () => {
    const body = await createBody({ tier: "standard", durationSeconds: 61 });
    const res = await postSession(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("tier_duration_mismatch");
  });

  it("creates exactly one session for one payment and replays idempotently", async () => {
    const body = await createBody();
    const { header, body: signedBody } = await createSessionPayment(apiUrl, body);
    const first = await postSession(signedBody, header);
    expect(first.status).toBe(201);
    const created = (await first.json()) as { sessionId: string; capability: string };
    const before = store.countSessions();

    const replay = await postSession(signedBody, header);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { sessionId: string; capability: string };
    expect(replayBody.sessionId).toBe(created.sessionId);
    expect(replayBody.capability).toBe(created.capability);
    expect(store.countSessions()).toBe(before);
  });

  it("returns the session view with the create and skips the post-create getSession", async () => {
    const body = await createBody();
    const { header, body: signedBody } = await createSessionPayment(apiUrl, body);
    const lookup = vi.spyOn(apiController, "getSession");
    try {
      const res = await postSession(signedBody, header);
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        sessionId: string;
        capability: string;
        state: SessionStatus["state"];
        limits: SessionStatus["limits"];
        session?: SessionStatus;
      };
      // The view came from the completion response, not a second controller call.
      expect(lookup).not.toHaveBeenCalled();
      expect(created.session).toBeDefined();
      expect(created.session).toMatchObject({
        sessionId: created.sessionId,
        state: created.state,
        limits: created.limits,
        clientNonce: body.clientNonce,
        busy: false,
      });
      // PAID has no lease yet, so the embedded view agrees with the status route.
      expect(created.session?.remainingSeconds).toBe(0);

      const statusRes = await fetch(`${apiUrl}/v1/sessions/${created.sessionId}`, {
        headers: { "x-sandbox-capability": created.capability },
      });
      expect(statusRes.status).toBe(200);
      const status = (await statusRes.json()) as SessionStatus;
      expect(status).toMatchObject({
        sessionId: created.session?.sessionId,
        tier: created.session?.tier,
        durationSeconds: created.session?.durationSeconds,
        createdAt: created.session?.createdAt,
        limits: created.session?.limits,
      });
      expect(status.payment.amount).toBe(created.session?.payment.amount);
    } finally {
      lookup.mockRestore();
    }
  });

  it("builds the SDK handle from the embedded create view", async () => {
    const handle = await client.createSession({
      tier: "custom",
      durationSeconds: 30,
      cpuMillis: 500,
      memoryMiB: 512,
      diskMiB: 256,
    });
    try {
      expect(handle.status).toMatchObject({
        sessionId: handle.sessionId,
        state: "PAID",
        clientNonce: handle.clientNonce,
        busy: false,
      });
      expect(handle.status?.clientNonce).toBe(handle.clientNonce);
      expect(Date.parse(handle.status!.createdAt)).toBeGreaterThan(Date.now() - 60_000);
      expect(handle.status?.payment.priceUsd).toMatch(/^\$/);
      // The embedded view is the server's view, not a locally invented one.
      expect(handle.status?.tier).toBe("custom");
    } finally {
      await client.destroy(handle).catch(() => undefined);
    }
  }, 20_000);

  it("does not let a receipt holder bind the session to their own client key", async () => {
    // B has A's PAYMENT-SIGNATURE but not A's wallet. B tries to bind the
    // session to B's client key before A submits.
    const bodyA = await createBody();
    const { header, challenge, body: signedA } = await createSessionPayment(apiUrl, bodyA);
    const bodyB = await createBody();
    const b = privateKeyToAccount(generatePrivateKey());
    const payload = decodePaymentSignatureHeader(header);
    const bSignature = await b.signMessage({
      message: clientCommitmentMessage({
        paymentKey: paymentKey(payload),
        clientPublicKey: bodyB.clientPublicKey,
        clientNonce: bodyB.clientNonce,
      }),
    });

    const before = store.countSessions();
    const hijack = await postSession({ ...bodyB, clientSignature: bSignature }, header);
    expect(hijack.status).toBe(401);
    expect(((await hijack.json()) as { error: string }).error).toBe("client_proof_invalid");
    expect(store.countSessions()).toBe(before);
    expect(challenge.requirement.amount).toBeTruthy();

    // A's own request still works: the hijack attempt consumed nothing.
    const created = await postSession(signedA, header);
    expect(created.status).toBe(201);
    expect(store.countSessions()).toBe(before + 1);
  });

  it("does not return a capability to a client that only holds the receipt", async () => {
    // A pays and owns a live session. B steals the header and asks for the
    // capability with its own client key, then with A's key but no proof.
    const bodyA = await createBody();
    const { header, body: signedA, account: payer } = await createSessionPayment(apiUrl, bodyA);
    const first = await postSession(signedA, header);
    expect(first.status).toBe(201);
    const created = (await first.json()) as { sessionId: string; capability: string };

    const bodyB = await createBody();
    const b = privateKeyToAccount(generatePrivateKey());
    const payload = decodePaymentSignatureHeader(header);
    const bSignature = await b.signMessage({
      message: clientCommitmentMessage({
        paymentKey: paymentKey(payload),
        clientPublicKey: bodyB.clientPublicKey,
        clientNonce: bodyB.clientNonce,
      }),
    });

    // B's own wallet cannot sign A's payment: rejected before any intent work.
    const bAttempt = await postSession({ ...bodyB, clientSignature: bSignature }, header);
    expect(bAttempt.status).toBe(401);
    expect(((await bAttempt.json()) as { error: string }).error).toBe("client_proof_invalid");

    // Even the payer's wallet, signing a *different* client key for the same
    // receipt, is a different spec: no capability is minted for it.
    const bodyA2 = await createBody();
    const aDifferentKeySignature = await payer.signMessage({
      message: clientCommitmentMessage({
        paymentKey: paymentKey(payload),
        clientPublicKey: bodyA2.clientPublicKey,
        clientNonce: bodyA2.clientNonce,
      }),
    });
    const withDifferentKey = await postSession(
      { ...bodyA2, clientSignature: aDifferentKeySignature },
      header,
    );
    expect(withDifferentKey.status).toBe(409);
    const rejected = (await withDifferentKey.json()) as { error: string; capability?: string };
    expect(rejected.capability).toBeUndefined();
    expect(["spec_mismatch", "capacity_unavailable"]).toContain(rejected.error);

    // Same client key but no proof of possession.
    const withoutProof = await postSession(bodyA, header);
    expect(withoutProof.status).toBe(401);
    expect(((await withoutProof.json()) as { error: string }).error).toBe("client_proof_required");

    // The rightful owner can still present the capability.
    const status = await fetch(`${apiUrl}/v1/sessions/${created.sessionId}`, {
      headers: { "x-sandbox-capability": created.capability },
    });
    expect(status.status).toBe(200);
  });

  it("cannot create multiple sessions under concurrent retries", async () => {
    const body = await createBody();
    const { header, body: signedBody } = await createSessionPayment(apiUrl, body);
    const before = store.countSessions();
    const results = await Promise.all(Array.from({ length: 6 }, () => postSession(signedBody, header)));
    const created = results.filter((r) => r.status === 201).length;
    const idempotent = results.filter((r) => r.status === 200).length;
    const rejected = results.filter((r) => r.status === 409).length;
    expect(created).toBe(1);
    expect(created + idempotent).toBeGreaterThanOrEqual(1);
    expect(created + idempotent + rejected).toBe(6);
    expect(store.countSessions()).toBe(before + 1);
  });

  it("does not create a session when settlement fails", async () => {
    facilitator.setFailSettle(true);
    try {
      const body = await createBody();
      const { header, body: signedBody } = await createSessionPayment(apiUrl, body);
      const before = store.countSessions();
      const res = await postSession(signedBody, header);
      expect(res.status).toBe(402);
      expect(store.countSessions()).toBe(before);
    } finally {
      facilitator.setFailSettle(false);
    }
  });

  it("recovers an entitlement when the payment settled before the API crashed", async () => {
    const body = await createBody();
    const { header, challenge, body: signedBody } = await createSessionPayment(apiUrl, body);
    // Settle directly with the facilitator, simulating a crash after settlement
    // but before the entitlement was durable.
    const payload = decodePaymentSignatureHeader(header);
    const settle = await fetch(`http://127.0.0.1:${FACILITATOR_PORT}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: challenge.requirement }),
    });
    expect(((await settle.json()) as { success: boolean }).success).toBe(true);

    const before = store.countSessions();
    const res = await postSession(signedBody, header);
    expect(res.status).toBe(201);
    expect(store.countSessions()).toBe(before + 1);
  });

  it("recovers when the controller crashes after settlement but before entitlement", async () => {
    const body = await createBody();
    const { header, body: signedBody } = await createSessionPayment(apiUrl, body);
    const before = store.countSessions();
    const paymentsBefore = store.countPayments();
    const original = apiController.completeIntent.bind(apiController);
    (apiController as unknown as { completeIntent: typeof apiController.completeIntent }).completeIntent = async () => {
      throw new ControllerError(503, "injected_crash", "simulated controller crash after settlement");
    };
    try {
      const first = await postSession(signedBody, header);
      expect(first.status).toBe(503);
      expect(store.countSessions()).toBe(before);
    } finally {
      (apiController as unknown as { completeIntent: typeof apiController.completeIntent }).completeIntent = original;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const retry = await postSession(signedBody, header);
    expect(retry.status).toBe(201);
    expect(store.countSessions()).toBe(before + 1);
    // Exactly-once accounting: the retry recovered the settled payment rather
    // than charging a second time.
    expect(store.countPayments()).toBe(paymentsBefore + 1);
    const created = (await retry.json()) as { sessionId: string; capability: string };

    // The same client can recover the same capability, and no second charge is
    // recorded.
    const recovered = await postSession(signedBody, header);
    expect(recovered.status).toBe(200);
    expect(((await recovered.json()) as { capability: string }).capability).toBe(created.capability);
    expect(store.countPayments()).toBe(paymentsBefore + 1);

    await fetch(`${apiUrl}/v1/sessions/${created.sessionId}`, {
      method: "DELETE",
      headers: { "x-sandbox-capability": created.capability },
    }).catch(() => undefined);
  }, 30_000);

  it("adopts a Pod created just before the controller crashed", async () => {
    const original = provisioner.createPod.bind(provisioner);
    let failOnce = true;
    provisioner.createPod = async (spec) => {
      const result = await original(spec);
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated controller crash after Pod creation");
      }
      return result;
    };
    try {
      const handle = await client.createSession({ tier: "custom", durationSeconds: 60, cpuMillis: 500, memoryMiB: 512, diskMiB: 256 });
      const ready = await client.waitForReady(handle, 20_000);
      expect(ready.state).toBe("READY");
      await client.destroy(handle);
    } finally {
      provisioner.createPod = original;
    }
  }, 30_000);

  it("scopes capabilities to a single session", async () => {
    const a = await client.createSession({ tier: "custom", durationSeconds: 30 });
    const b = await client.createSession({ tier: "custom", durationSeconds: 30 });
    const res = await fetch(`${apiUrl}/v1/sessions/${b.sessionId}`, {
      headers: { "x-sandbox-capability": a.capability },
    });
    expect(res.status).toBe(404);
    await client.destroy(a).catch(() => undefined);
    await client.destroy(b).catch(() => undefined);
  });
});

describe("session execution", () => {
  it("runs many commands against one persistent filesystem, then destroys", async () => {
    const handle = await client.createSession({ tier: "standard" });
    const ready = await client.waitForReady(handle);
    expect(ready.state).toBe("READY");
    expect(ready.attestation?.insecureDevOnly).toBe(true);
    expect(ready.leaseExpiresAt).toBeTruthy();
    expect(ready.remainingSeconds).toBeGreaterThan(280);

    const py = await client.exec(handle, { command: ["python3", "--version"] });
    expect(py.ok).toBe(true);
    if (py.ok) expect(py.stdout).toContain("Python");

    const mk = await client.exec(handle, { command: ["bash", "-c", "mkdir -p sub && echo hello > test.txt"] });
    expect(mk.ok).toBe(true);

    const cat = await client.exec(handle, { command: ["cat", "test.txt"] });
    expect(cat.ok).toBe(true);
    if (cat.ok) expect(cat.stdout).toBe("hello\n");

    const env = await client.exec(handle, { command: ["bash", "-c", "echo $GREETING"], env: { GREETING: "hi" } });
    if (env.ok) expect(env.stdout.trim()).toBe("hi");

    const code = await client.exec(handle, { command: ["bash", "-c", "echo err >&2; exit 9"] });
    if (code.ok) {
      expect(code.exitCode).toBe(9);
      expect(code.stderr.trim()).toBe("err");
    }

    const status = await client.status(handle);
    expect(status.state).toBe("READY");

    const destroyed = await client.destroy(handle);
    expect(destroyed?.state).toBe("DESTROYED");
    expect(store.getSession(handle.sessionId)?.podName).toBeNull();
  }, 90_000);

  it("runs one-shot: uploads, collects returns, and destroys the session", async () => {
    const result = await client.run({
      tier: "custom",
      durationSeconds: 60,
      command: [
        "bash",
        "-c",
        "mkdir -p out && tr a-z A-Z < in.txt > out/upper.txt && echo done >&2",
      ],
      files: { "in.txt": "hello\n" },
      returnFiles: ["out/upper.txt"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("done");
    expect(Buffer.from(result.files["out/upper.txt"]!).toString()).toBe("HELLO\n");
    expect(store.getSession(result.sessionId)?.state).toBe("DESTROYED");
  }, 90_000);

  it("uploads, lists, stats, downloads files and round-trips archives", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);

    const put = await client.putFile(handle, { path: "upload/hello.txt", data: Buffer.from("uploaded\n") });
    expect(put.ok).toBe(true);

    const list = await client.listFiles(handle, "upload");
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.entries.map((e) => e.path)).toContain("upload/hello.txt");

    const stat = await client.statFile(handle, "upload/hello.txt");
    if (stat.ok) expect(stat.entry?.size).toBe(9);

    const get = await client.getFile(handle, "upload/hello.txt");
    expect(get.ok).toBe(true);
    if (get.ok) expect(Buffer.from(get.dataBase64, "base64").toString()).toBe("uploaded\n");

    const archive = await client.putFile(handle, {
      path: "tree",
      data: makeTar([
        { name: "a.txt", content: "one" },
        { name: "nested/b.txt", content: "two" },
      ]),
      archive: true,
    });
    expect(archive.ok).toBe(true);

    const tar = await client.getFile(handle, "tree", true);
    expect(tar.ok).toBe(true);
    if (tar.ok) expect(Buffer.from(tar.dataBase64, "base64").length).toBeGreaterThan(50);

    const escaped = await client.getFile(handle, "../../etc/passwd");
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.error?.code).toMatch(/path_outside_workspace|symlink_escape/);

    await client.destroy(handle);
  }, 90_000);

  it("enforces per-command timeouts and rejects concurrent operations", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);

    const timeout = await client.exec(handle, {
      command: ["bash", "-c", "sleep 30 & echo $! > bg.pid; wait"],
      timeoutMs: 500,
    });
    expect(timeout.ok).toBe(true);
    if (timeout.ok) {
      expect(timeout.timedOut).toBe(true);
      expect(timeout.durationMs).toBeLessThan(5000);
    }
    const check = await client.exec(handle, {
      command: ["bash", "-c", "kill -0 $(cat bg.pid) 2>/dev/null && echo alive || echo dead"],
    });
    if (check.ok) expect(check.stdout.trim()).toBe("dead");

    const long = client.exec(handle, { command: ["sleep", "5"] });
    await sleep(500);
    await expect(client.exec(handle, { command: ["echo", "nope"] })).rejects.toMatchObject({ code: "session_busy" });
    const finished = await long;
    expect(finished.ok).toBe(true);

    await client.destroy(handle);
  }, 90_000);

  it("does not execute twice when a request is retried with the same id", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);

    const requestId = "retry-test-request-0001";
    const first = await client.exec(handle, {
      command: ["bash", "-c", "echo x >> counter.txt; wc -l < counter.txt"],
      requestId,
    });
    const second = await client.exec(handle, {
      command: ["bash", "-c", "echo x >> counter.txt; wc -l < counter.txt"],
      requestId,
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.stdout.trim()).toBe("1");
      expect(second.stdout.trim()).toBe("1");
    }
    await client.destroy(handle);
  }, 90_000);

  it("survives a client disconnect and returns the result by request id", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);

    const requestId = "disconnect-request-0001";
    const controller = new AbortController();
    const pending = client
      .exec(handle, {
        command: ["bash", "-c", "sleep 2; echo finished-after-disconnect"],
        requestId,
        signal: controller.signal,
      })
      .catch((err: unknown) => err);
    setTimeout(() => controller.abort(), 400);
    const aborted = await pending;
    expect(aborted).toBeInstanceOf(Error);

    const result = await client.getOperation(handle, requestId, 30_000);
    expect(result).toBeTruthy();
    expect(result?.ok).toBe(true);
    if (result?.ok && result.op === "exec") {
      expect(result.stdout).toContain("finished-after-disconnect");
    }
    await client.destroy(handle);
  }, 90_000);

  it("expires short leases and refuses work afterwards", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 3 });
    const ready = await client.waitForReady(handle);
    expect(ready.remainingSeconds).toBeLessThanOrEqual(3);

    await sleep(5000);
    const final = await pollStatus(handle, (s) => ["EXPIRED", "TERMINATING", "DESTROYED"].includes(s.state), 20_000);
    expect(["EXPIRED", "TERMINATING", "DESTROYED"]).toContain(final.state);

    const late = await client.exec(handle, { command: ["echo", "late"] }).catch((err: unknown) => err);
    expect(late).toBeInstanceOf(SandboxError);
    expect(["lease_expired", "session_not_usable", "guest_not_available", "session_busy", "control_plane_unavailable"]).toContain(
      (late as SandboxError).code,
    );
  }, 60_000);
});

describe("local services and HTTP data plane", () => {
  it("starts a loopback server and fetches it through the relay", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);
    await client.putFile(handle, { path: "index.html", data: Buffer.from("hello-http\n") });

    const info = await client.startService(handle, {
      name: "web",
      command: ["python3", "-m", "http.server", "18080", "--bind", "127.0.0.1"],
      port: 18080,
    });
    expect(info.state).toBe("running");
    expect(info.port).toBe(18080);

    const services = await client.listServices(handle);
    expect(services.map((s) => s.name)).toContain("web");

    const response = await client.http(handle, { port: 18080, path: "/", method: "GET" });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toContain("hello-http");

    // A port that is not declared by a running service is rejected.
    await expect(client.http(handle, { port: 18081, path: "/" })).rejects.toMatchObject({
      code: "service_unavailable",
    });

    await client.stopService(handle, "web");
    await expect(client.http(handle, { port: 18080, path: "/" })).rejects.toMatchObject({
      code: "service_unavailable",
    });
    await client.destroy(handle);
  }, 180_000);
});

describe("streaming HTTP data plane", () => {
  it("streams SSE chunks through the relay", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);
    await client.putFile(handle, {
      path: "sse.py",
      data: Buffer.from(
        [
          "from http.server import BaseHTTPRequestHandler, HTTPServer",
          "import time",
          "class H(BaseHTTPRequestHandler):",
          "    def do_GET(self):",
          "        self.send_response(200)",
          "        self.send_header('Content-Type', 'text/event-stream')",
          "        self.end_headers()",
          "        for i in range(5):",
          "            self.wfile.write(f'data: tick {i}\\n\\n'.encode())",
          "            self.wfile.flush()",
          "            time.sleep(0.2)",
          "HTTPServer(('127.0.0.1', 18082), H).serve_forever()",
        ].join("\n"),
      ),
    });
    await client.startService(handle, {
      name: "sse",
      command: ["python3", "sse.py"],
      port: 18082,
    });
    const stream = await client.openHttpStream(handle, { port: 18082, path: "/events" });
    let text = "";
    let done = false;
    for (let i = 0; i < 100 && !done; i++) {
      const part = await stream.read();
      if (part.chunk) text += part.chunk.toString();
      done = part.done;
    }
    expect(text).toContain("tick 0");
    expect(text).toContain("tick 4");
    await stream.close();
    await client.stopService(handle, "sse");
    await client.destroy(handle);
  }, 180_000);
});

describe("WebSocket data plane", () => {
  it("echoes a message through the relay", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);
    await client.putFile(handle, {
      path: "ws-echo-server.js",
      data: readFileSync(join(process.cwd(), "scripts/ws-echo-server.js")),
    });
    await client.startService(handle, {
      name: "ws",
      command: ["node", "ws-echo-server.js"],
      port: 18084,
      env: hostPathEnv,
    });
    const ws = await client.openWebSocket(handle, { port: 18084, path: "/" });
    await ws.send("hello-ws");
    let reply = "";
    for (let i = 0; i < 50 && !reply; i++) {
      const part = await ws.read();
      if (part.data) reply = part.data.toString();
      if (part.done) break;
    }
    expect(reply).toBe("hello-ws");
    await ws.close();
    await client.stopService(handle, "ws");
    await client.destroy(handle);
  }, 180_000);
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
      if (store.getSession(sessionId)?.destroyRequested === 1) return;
      await sleep(50);
    }
    throw new Error("destroy request was not recorded");
  }

  it("destroys a suspended session instead of orphaning it", async () => {
    const handle = await suspendableSession();
    await client.suspend(handle);
    expect(store.getSession(handle.sessionId)?.state).toBe("SUSPENDED");

    const destroyed = await client.destroy(handle, 20_000);
    expect(destroyed?.state).toBe("DESTROYED");
    const row = store.getSession(handle.sessionId);
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
    expect(store.getSession(handle.sessionId)?.state).toBe("SUSPENDED");
    await expectNoPods(handle.sessionId);

    await client.destroy(handle, 20_000);
    expect(store.getSession(handle.sessionId)?.state).toBe("DESTROYED");
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
    expect(store.getSession(handle.sessionId)?.state).toBe("DESTROYED");
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
    expect(store.getSession(handle.sessionId)?.state).toBe("DESTROYED");
    await expectNoPods(handle.sessionId);
  }, 60_000);

  it("accepts duplicate destroys and still reaches a single terminal state", async () => {
    const handle = await suspendableSession();
    const results = await Promise.allSettled([
      client.destroy(handle, 20_000),
      client.destroy(handle, 20_000),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(store.getSession(handle.sessionId)?.state).toBe("DESTROYED");
    await expectNoPods(handle.sessionId);
  }, 60_000);
});

describe("payment ledger and refunds", () => {
  it("refunds a paid session that never becomes ready", async () => {
    const original = provisioner.createPod.bind(provisioner);
    provisioner.createPod = async () => {
      throw new Error("simulated provisioning failure before READY");
    };
    try {
      const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
      expect(store.getLedgerBySession(handle.sessionId)?.status).toBe("SETTLED");
      store.requestTermination(handle.sessionId, "failure:simulated_provisioning");
      reconciler.wake();
      const terminal = await pollStatus(
        handle,
        (status) => status.state === "FAILED" || status.state === "EXPIRED" || status.state === "DESTROYED",
        15_000,
      );
      expect(terminal.state).toBe("FAILED");
      const ledger = store.getLedgerBySession(handle.sessionId);
      expect(ledger).toMatchObject({
        status: "REFUNDED",
        sessionId: handle.sessionId,
      });
      expect(ledger?.refundTransaction).toMatch(/^mock:refund:/);
    } finally {
      provisioner.createPod = original;
    }
  }, 60_000);

  it("does not refund a session that reached READY", async () => {
    const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(handle);
    const destroyed = await client.destroy(handle, 30_000);
    expect(destroyed?.state).toBe("DESTROYED");
    expect(store.getLedgerBySession(handle.sessionId)?.status).toBe("SETTLED");
  }, 60_000);
});

describe("capacity admission", () => {
  it("rejects an oversized session before payment", async () => {
    await expect(
      client.createSession({
        tier: "custom",
        durationSeconds: 60,
        cpuMillis: 1000,
        memoryMiB: 8192,
        diskMiB: 1024,
        baselineCpuMillis: 500,
        baselineMemoryMiB: 4096,
      }),
    ).rejects.toMatchObject({ code: "capacity_unavailable" });
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
        state = store.reservations.getBySession(handle.sessionId)?.state ?? "gone";
        if (state === "RELEASING") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(state).toBe("RELEASING");
    } finally {
      provisioner.deletePod = original;
    }
    let finalState = "";
    for (let i = 0; i < 40; i += 1) {
      finalState = store.reservations.getBySession(handle.sessionId)?.state ?? "gone";
      if (finalState === "RELEASED" || finalState === "gone") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(["RELEASED", "gone"]).toContain(finalState);
  }, 30_000);
});

describe("configuration guards", () => {
  it("refuses mainnet", () => {
    expect(() =>
      loadConfig({
        PAYMENT_MODE: "testnet",
        NETWORK: "eip155:8453",
        PAY_TO: "0x1111111111111111111111111111111111111111",
        CAPABILITY_SECRET: "capability-secret-0123456789",
      }),
    ).toThrow(/mainnet/i);
  });

  it("refuses mock payments without the explicit dev acknowledgement", () => {
    expect(() =>
      loadConfig({ PAYMENT_MODE: "mock", ALLOW_INSECURE_DEV: "false", CAPABILITY_SECRET: "capability-secret-0123456789" }),
    ).toThrow(/insecure/i);
  });
});

void requestChallenge;
void fromBase64;
