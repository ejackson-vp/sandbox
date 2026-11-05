/**
 * End-to-end control-plane test: real x402 handshake, real controller/store/
 * relay/reconciler, real guest process (LocalProvisioner). Only Kubernetes pod
 * creation is substituted; tests/security covers the real cluster.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockFacilitator, type MockFacilitatorHandle } from "../../api/src/mock-facilitator.js";
import { createApp } from "../../api/src/server.js";
import { loadConfig } from "../../api/src/config.js";
import { ControllerClient } from "../../api/src/controller-client.js";
import { createControlApi } from "../../controller/src/control-api.js";
import { createRelay, type RelayServer } from "../../controller/src/relay.js";
import { RelayClient } from "../../controller/src/relay-client.js";
import { Reconciler } from "../../controller/src/reconciler.js";
import { Store } from "../../controller/src/store.js";
import { LocalProvisioner } from "../../controller/src/local-provisioner.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import {
  fromBase64,
  generateBoxKeyPair,
  generateNonce,
  openSealedJson,
  sealJsonTo,
  toBase64,
  verifyAttestation,
  type ExecutePlaintext,
  type ResultPlaintext,
  type SandboxStatus,
} from "../../shared/src/index.js";
import { createSandboxPayment, createMockPayingClient } from "../helpers/x402.js";

const API_PORT = 13200;
const FACILITATOR_PORT = 13202;
const CONTROLLER_PORT = 13201;
const RELAY_PORT = 18444;
const ADMIN = "integration-admin-token-0123456789";
const DEV_SEED = "qSgP+dPwGhb/58O0ZD/dSqCMovhhWNIQbT3MeTD35WY=";
const GUEST_BINARY = process.env.GUEST_BINARY ?? join(process.cwd(), "guest/bin/x402-guest");

let facilitator: MockFacilitatorHandle;
let relay: RelayServer;
let store: Store;
let reconciler: Reconciler;
let servers: http.Server[] = [];
let workDir: string;
const apiUrl = `http://127.0.0.1:${API_PORT}`;

function listen(app: http.RequestListener | http.Server, port: number): Promise<http.Server> {
  const server = http.createServer(app as http.RequestListener);
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollStatus(id: string, capability: string, until: (s: SandboxStatus) => boolean, timeoutMs = 30_000): Promise<SandboxStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: SandboxStatus | undefined;
  while (Date.now() < deadline) {
    const res = await fetch(`${apiUrl}/v1/sandboxes/${id}`, { headers: { "x-sandbox-capability": capability } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    last = (await res.json()) as SandboxStatus;
    if (until(last)) return last;
    await sleep(150);
  }
  throw new Error(`timeout; last state ${last?.state}`);
}

async function createAndPay(body: Record<string, unknown>, header?: string): Promise<Response> {
  return fetch(`${apiUrl}/v1/sandboxes`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(header ? { "PAYMENT-SIGNATURE": header } : {}) },
    body: JSON.stringify(body),
  });
}

function newClientKeys() {
  return generateBoxKeyPair();
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "x402-integration-"));

  facilitator = await createMockFacilitator({ dbPath: join(workDir, "facilitator.db") });
  const facServer = await listen(facilitator.app, FACILITATOR_PORT);
  servers.push(facServer);

  relay = createRelay({ adminToken: ADMIN, resultTtlMs: 30_000 });
  await new Promise<void>((r) => relay.server.listen(RELAY_PORT, "127.0.0.1", () => r()));

  const relayClient = new RelayClient({ baseUrl: `http://127.0.0.1:${RELAY_PORT}`, adminToken: ADMIN });
  store = new Store(join(workDir, "controller.db"));

  const controllerCfg = loadControllerConfig({
    ADMIN_TOKEN: ADMIN,
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DB_PATH: join(workDir, "controller.db"),
    RELAY_URL: `http://127.0.0.1:${RELAY_PORT}`,
    RELAY_ADMIN_TOKEN: ADMIN,
    PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
    GUEST_IMAGE: "x402-sandbox/guest:dev",
    RECONCILE_INTERVAL_MS: "100",
  });

  const provisioner = new LocalProvisioner({
    binary: GUEST_BINARY,
    relayHost: "127.0.0.1",
    relayPort: RELAY_PORT,
    proxyHost: "127.0.0.1",
    proxyPort: 3128,
    workRoot: join(workDir, "sandboxes"),
  });

  const controlApp = createControlApi({ cfg: controllerCfg, store, relay: relayClient });
  const controlServer = await listen(controlApp, CONTROLLER_PORT);
  servers.push(controlServer);

  reconciler = new Reconciler({ cfg: controllerCfg, store, provisioner, relay: relayClient });
  reconciler.start();

  const apiCfg = loadConfig({
    PORT: String(API_PORT),
    PAYMENT_MODE: "mock",
    FACILITATOR_URL: `http://127.0.0.1:${FACILITATOR_PORT}`,
    CONTROLLER_URL: `http://127.0.0.1:${CONTROLLER_PORT}`,
    CONTROLLER_ADMIN_TOKEN: ADMIN,
    PUBLIC_BASE_URL: apiUrl,
    ALLOW_INSECURE_DEV: "true",
    PRICE_USD: "$0.01",
  });

  const app = await createApp({
    config: apiCfg,
    controller: new ControllerClient(apiCfg.controllerUrl, adminToken()),
  });
  const apiServer = await listen(app, API_PORT);
  servers.push(apiServer);

  process.env.DEV_ATTESTATION_KEY = DEV_SEED;
  process.env.DEV_ATTESTATION_KEY_ID = "x402-dev-attestation-key-INSECURE-DEV-ONLY";
});

function adminToken(): string {
  return ADMIN;
}

afterAll(async () => {
  reconciler?.stop();
  await relay?.close();
  for (const s of servers) await close(s).catch(() => undefined);
  facilitator?.close();
  store?.close();
  await rm(workDir, { recursive: true, force: true });
});

describe("payments", () => {
  const baseBody = async () => ({
    durationSeconds: 10,
    clientPublicKey: toBase64((await newClientKeys()).publicKey),
    clientNonce: toBase64(await generateNonce()),
    language: "python3",
  });

  it("returns 402 with x402 v2 payment requirements when unpaid", async () => {
    const res = await createAndPay(await baseBody());
    expect(res.status).toBe(402);
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0].scheme).toBe("exact");
    expect(decoded.accepts[0].network).toBe("mock:local");
    expect(decoded.accepts[0].amount).toBe("10000");
    expect(store.countSessions()).toBe(0);
  });

  it("rejects a tampered payment payload", async () => {
    const body = await baseBody();
    const { header } = await createSandboxPayment(apiUrl, body);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    decoded.payload.authorization.value = "1";
    const tampered = Buffer.from(JSON.stringify(decoded)).toString("base64");
    const res = await createAndPay(body, tampered);
    expect(res.status).toBe(402);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/payment_invalid|payment_settlement_rejected/);
    expect(store.countSessions()).toBe(0);
  });

  it("rejects plaintext code fields", async () => {
    const res = await fetch(`${apiUrl}/v1/sandboxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(await baseBody()), code: "print(1)" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("plaintext_not_accepted");
  });

  it("creates exactly one entitlement for one settled payment", async () => {
    const before = store.countSessions();
    const body = await baseBody();
    const { header } = await createSandboxPayment(apiUrl, body);
    const res = await createAndPay(body, header);
    expect(res.status).toBe(201);
    const created = (await res.json()) as { sandboxId: string; capability: string; payment: { transaction: string } };
    expect(created.sandboxId).toMatch(/^sbx_[0-9a-f]{24}$/);
    expect(created.capability.length).toBeGreaterThan(30);
    expect(created.payment.transaction).toMatch(/^mock:/);
    expect(store.countSessions()).toBe(before + 1);
  });

  it("rejects a replayed payment without provisioning a second sandbox", async () => {
    const body = await baseBody();
    const { header } = await createSandboxPayment(apiUrl, body);
    const first = await createAndPay(body, header);
    expect(first.status).toBe(201);
    const before = store.countSessions();

    const replay = await createAndPay(body, header);
    expect(replay.status).toBe(402);
    const json = (await replay.json()) as { error: string };
    expect(json.error).toMatch(/payment_settlement_rejected|payment_invalid/);
    expect(store.countSessions()).toBe(before);
  });

  it("cannot provision multiple sandboxes under concurrent retries", async () => {
    const body = await baseBody();
    const { header } = await createSandboxPayment(apiUrl, body);
    const before = store.countSessions();
    const results = await Promise.all(Array.from({ length: 6 }, () => createAndPay(body, header)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 402 || s === 409)).toHaveLength(5);
    expect(store.countSessions()).toBe(before + 1);
  });

  it("does not create an entitlement when settlement fails", async () => {
    facilitator.setFailSettle(true);
    try {
      const body = await baseBody();
      const { header } = await createSandboxPayment(apiUrl, body);
      const before = store.countSessions();
      const res = await createAndPay(body, header);
      expect(res.status).toBe(402);
      const json = (await res.json()) as { error: string };
      expect(json.error).toContain("payment_settlement_rejected");
      expect(store.countSessions()).toBe(before);
    } finally {
      facilitator.setFailSettle(false);
    }
  });

  it("scopes capabilities to a single session", async () => {
    const a = await createSandboxPayment(apiUrl, await baseBody());
    const b = await createSandboxPayment(apiUrl, await baseBody());
    const resA = await createAndPay(await baseBody(), a.header);
    const resB = await createAndPay(await baseBody(), b.header);
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    const createdA = (await resA.json()) as { sandboxId: string; capability: string };
    const createdB = (await resB.json()) as { sandboxId: string; capability: string };

    const cross = await fetch(`${apiUrl}/v1/sandboxes/${createdB.sandboxId}`, {
      headers: { "x-sandbox-capability": createdA.capability },
    });
    expect(cross.status).toBe(404);
  });
});

describe("execution lifecycle", () => {
  it("provisions, attests, executes and returns an encrypted result", async () => {
    const keys = await newClientKeys();
    const clientNonce = toBase64(await generateNonce());
    const body = {
      durationSeconds: 30,
      clientPublicKey: toBase64(keys.publicKey),
      clientNonce,
      language: "python3",
    };
    const { header } = await createSandboxPayment(apiUrl, body);
    const res = await createAndPay(body, header);
    expect(res.status).toBe(201);
    const created = (await res.json()) as { sandboxId: string; capability: string };
    const auth = { "x-sandbox-capability": created.capability };

    const ready = await pollStatus(created.sandboxId, created.capability, (s) => s.state === "READY");
    expect(ready.attestation).toBeTruthy();
    expect(ready.executionMode).toBe("dev");
    expect(ready.guestPublicKey).toBeTruthy();

    const verdict = verifyAttestation(ready.attestation, {
      mode: "dev",
      allowInsecureDev: true,
      expectedSessionId: created.sandboxId,
      expectedClientNonce: clientNonce,
      expectedClientPublicKey: toBase64(keys.publicKey),
    });
    expect(verdict.ok).toBe(true);

    // Production policy must reject the same simulated evidence.
    const asProduction = verifyAttestation(ready.attestation, {
      mode: "confidential",
      allowInsecureDev: false,
      expectedSessionId: created.sandboxId,
      expectedClientNonce: clientNonce,
      expectedClientPublicKey: toBase64(keys.publicKey),
    });
    expect(asProduction.ok).toBe(false);

    const envelope = await sealJsonTo(fromBase64(ready.guestPublicKey!), {
      v: 1,
      sessionId: created.sandboxId,
      clientNonce,
      language: "python3",
      code: "print('integration hello')\nimport sys\nprint('err', file=sys.stderr)\nsys.exit(4)\n",
    } satisfies ExecutePlaintext);

    const exec = await fetch(`${apiUrl}/v1/sandboxes/${created.sandboxId}/execute`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ envelope }),
    });
    expect(exec.status).toBe(202);

    const resultRes = await fetch(`${apiUrl}/v1/sandboxes/${created.sandboxId}/result`, { headers: auth });
    expect(resultRes.status).toBe(200);
    const resultBody = (await resultRes.json()) as { envelope: string; state: string };
    const result = await openSealedJson<ResultPlaintext>(resultBody.envelope, keys.publicKey, keys.privateKey);
    expect(result.stdout).toContain("integration hello");
    expect(result.stderr).toContain("err");
    expect(result.exitCode).toBe(4);

    // A second execution must be refused.
    const second = await fetch(`${apiUrl}/v1/sandboxes/${created.sandboxId}/execute`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ envelope }),
    });
    expect([409, 410]).toContain(second.status);

    // Wrong key cannot decrypt.
    const wrong = await newClientKeys();
    await expect(openSealedJson<ResultPlaintext>(resultBody.envelope, wrong.publicKey, wrong.privateKey)).rejects.toThrow();

    // After the result is fetched the sandbox is destroyed.
    const destroyed = await pollStatus(created.sandboxId, created.capability, (s) => s.state === "DESTROYED");
    expect(destroyed.destroyedAt).toBeTruthy();
  }, 90_000);

  it("refuses execution after the 60s-style window ends and expires the sandbox", async () => {
    const keys = await newClientKeys();
    const clientNonce = toBase64(await generateNonce());
    const body = {
      durationSeconds: 2,
      clientPublicKey: toBase64(keys.publicKey),
      clientNonce,
      language: "python3",
    };
    const { header } = await createSandboxPayment(apiUrl, body);
    const res = await createAndPay(body, header);
    const created = (await res.json()) as { sandboxId: string; capability: string };
    const auth = { "x-sandbox-capability": created.capability, "content-type": "application/json" };

    const ready = await pollStatus(created.sandboxId, created.capability, (s) => s.state === "READY");
    expect(ready.executionDeadline).toBeTruthy();

    await sleep(3000);

    const envelope = await sealJsonTo(fromBase64(ready.guestPublicKey!), {
      v: 1,
      sessionId: created.sandboxId,
      clientNonce,
      language: "python3",
      code: "print('too late')",
    } satisfies ExecutePlaintext);
    const exec = await fetch(`${apiUrl}/v1/sandboxes/${created.sandboxId}/execute`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ envelope }),
    });
    expect([409, 410]).toContain(exec.status);

    const expired = await pollStatus(created.sandboxId, created.capability, (s) => s.state === "EXPIRED" || s.state === "FAILED");
    expect(["EXPIRED", "FAILED"]).toContain(expired.state);
  }, 60_000);

  it("rejects tampered execute envelopes without executing", async () => {
    const keys = await newClientKeys();
    const clientNonce = toBase64(await generateNonce());
    const body = {
      durationSeconds: 30,
      clientPublicKey: toBase64(keys.publicKey),
      clientNonce,
      language: "python3",
    };
    const { header } = await createSandboxPayment(apiUrl, body);
    const res = await createAndPay(body, header);
    const created = (await res.json()) as { sandboxId: string; capability: string };
    const ready = await pollStatus(created.sandboxId, created.capability, (s) => s.state === "READY");

    const validEnvelope = await sealJsonTo(fromBase64(ready.guestPublicKey!), {
      v: 1,
      sessionId: created.sandboxId,
      clientNonce,
      language: "python3",
      code: "print('should not run')",
    } satisfies ExecutePlaintext);
    const raw = Buffer.from(validEnvelope, "base64");
    raw[raw.length - 1] ^= 0xff; // corrupt the authenticator
    const tampered = raw.toString("base64");

    const exec = await fetch(`${apiUrl}/v1/sandboxes/${created.sandboxId}/execute`, {
      method: "POST",
      headers: { "x-sandbox-capability": created.capability, "content-type": "application/json" },
      body: JSON.stringify({ envelope: tampered }),
    });
    // Delivery is accepted (the relay is zero-knowledge) but the guest must
    // refuse and report an error rather than execute.
    expect([202, 409]).toContain(exec.status);

    const deadline = Date.now() + 20_000;
    let state = "RUNNING";
    while (Date.now() < deadline) {
      const s = await pollStatus(created.sandboxId, created.capability, () => true);
      state = s.state;
      if (state !== "RUNNING" && state !== "READY") break;
      await sleep(200);
    }
    expect(["FAILED", "EXPIRED"]).toContain(state);

    const result = await fetch(`${apiUrl}/v1/sandboxes/${created.sandboxId}/result`, {
      headers: { "x-sandbox-capability": created.capability },
    });
    const bodyJson = (await result.json()) as { envelope?: string };
    expect(bodyJson.envelope).toBeUndefined();
  }, 60_000);
});

describe("payment mode configuration", () => {
  it("refuses to start with mainnet payments", () => {
    expect(() =>
      loadConfig({
        PAYMENT_MODE: "testnet",
        NETWORK: "eip155:8453",
        PAY_TO: "0x1111111111111111111111111111111111111111",
      }),
    ).toThrow(/mainnet/i);
  });

  it("defaults to mock payments only with an explicit insecure acknowledgement", () => {
    expect(() => loadConfig({ PAYMENT_MODE: "mock", ALLOW_INSECURE_DEV: "false" })).toThrow(/insecure/i);
  });

  it("rejects confidential execution mode without a confidential runtime class", () => {
    expect(() =>
      loadControllerConfig({
        ROLE: "controller",
        EXECUTION_MODE: "confidential",
        RUNTIME_CLASS: "runc",
        ALLOW_INSECURE_DEV: "false",
        ADMIN_TOKEN: ADMIN,
      }),
    ).toThrow(/confidential/i);
  });
});
