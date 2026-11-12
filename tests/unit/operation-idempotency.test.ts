/**
 * The operation idempotency key is bound to the request payload.
 *
 * `requestId` alone is not enough: a client that reuses it for a different
 * operation must not receive the first operation's cached result. Sealing is
 * non-deterministic, so the binding is the client's hash of the canonical
 * operation plaintext, with the ciphertext hash as the fallback for clients that
 * do not send one. This file pins the controller decision, the API forwarding on
 * both the body and GET surfaces, and the SDK computing a stable hash across a
 * re-seal.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, generateBoxKeyPair, sealJsonTo, sha256Hex } from "../../shared/src/entries/crypto.js";
import { createControlApi } from "../../controller/src/control-api.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import { loadConfig } from "../../api/src/config.js";
import { createSessionsRouter } from "../../api/src/routes/sessions.js";
import { mintCapability } from "../../shared/src/capability.js";
import { SandboxClient } from "../../sdk/src/client.js";
import type { SessionHandle } from "../../sdk/src/types.js";
import { seedReadySession } from "./store-contract/fixtures.js";
import { freshStore, testDatabaseUrl } from "../helpers/test-store.js";

const PAYMENT_KEY = "a".repeat(64);
const SESSION_ID = `sbx_${"7".repeat(24)}`;
const REQUEST_ID = "idem-request-0001";
const ENVELOPE_A = "c2VhbGVkLWVudmVsb3BlLUE=";
const ENVELOPE_B = "c2VhbGVkLWVudmVsb3BlLUI=";

interface SentFrame {
  sessionId: string;
  requestId: string;
  envelope: string;
}

/** A relay that answers immediately with the envelope it was given. */
function stubRelay(): { relay: RelayClient; sent: SentFrame[] } {
  const sent: SentFrame[] = [];
  const relay = {
    async request(sessionId: string, requestId: string, envelope: string) {
      sent.push({ sessionId, requestId, envelope });
    },
    async response(sessionId: string, requestId: string) {
      const frame = sent.find((f) => f.sessionId === sessionId && f.requestId === requestId);
      return frame ? { kind: "envelope" as const, envelope: frame.envelope } : { kind: "pending" as const };
    },
    async cancel() {},
  };
  return { relay: relay as unknown as RelayClient, sent };
}

const servers: http.Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function startController(relay: RelayClient, store: PostgresStore): Promise<number> {
  const cfg = loadControllerConfig({
    ADMIN_TOKEN: "c".repeat(24),
    ROLE: "controller",
    KUBERNETES_ENABLED: "false",
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
    DATABASE_URL: testDatabaseUrl(),
  });
  const app = createControlApi({ cfg, store, relay, capacity: {} as CapacityService });
  const server = http.createServer(app);
  servers.push(server);
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

async function operate(
  port: number,
  envelope: string,
  payloadHash?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/internal/sessions/${SESSION_ID}/operations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": "c".repeat(24) },
    body: JSON.stringify({
      requestId: REQUEST_ID,
      envelope,
      op: "exec",
      waitMs: 0,
      ...(payloadHash ? { payloadHash } : {}),
    }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function seededController(): Promise<{ port: number; sent: SentFrame[] }> {
  const store = await freshStore();
  await seedReadySession(store, SESSION_ID, PAYMENT_KEY);
  const { relay, sent } = stubRelay();
  const port = await startController(relay, store);
  return { port, sent };
}

describe("operation idempotency binding in the controller", () => {
  it("keeps the ciphertext fallback for a client that sends no hash", async () => {
    const { port, sent } = await seededController();

    const first = await operate(port, ENVELOPE_A);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ requestId: REQUEST_ID, envelope: ENVELOPE_A });
    expect(sent).toHaveLength(1);

    // Same id, same ciphertext: the cached result, not a second execution.
    const replay = await operate(port, ENVELOPE_A);
    expect(replay.status).toBe(200);
    expect(replay.body.envelope).toBe(ENVELOPE_A);
    expect(sent).toHaveLength(1);

    // Same id, different ciphertext: the fallback cannot tell a re-seal from a
    // different operation, so it refuses. The client hash below fixes that.
    const reused = await operate(port, ENVELOPE_B);
    expect(reused.status).toBe(409);
    expect(reused.body).toEqual({ error: "idempotency_key_reused", requestId: REQUEST_ID });
    expect(sent).toHaveLength(1);
  });

  it("replays a re-sealed retry that carries the same canonical hash", async () => {
    const { port, sent } = await seededController();
    const payloadHash = "b".repeat(64);

    const first = await operate(port, ENVELOPE_A, payloadHash);
    expect(first.status).toBe(200);
    expect(first.body.envelope).toBe(ENVELOPE_A);

    // A second call re-seals the same logical operation: different ciphertext,
    // same canonical hash. That is an idempotent retry, not a key reuse.
    const replay = await operate(port, ENVELOPE_B, payloadHash);
    expect(replay.status).toBe(200);
    expect(replay.body.envelope).toBe(ENVELOPE_A);
    expect(sent).toHaveLength(1);
  });

  it("refuses a different canonical operation under the same request id", async () => {
    const { port, sent } = await seededController();

    expect((await operate(port, ENVELOPE_A, "b".repeat(64))).status).toBe(200);

    const reused = await operate(port, ENVELOPE_B, "c".repeat(64));
    expect(reused.status).toBe(409);
    expect(reused.body).toEqual({ error: "idempotency_key_reused", requestId: REQUEST_ID });
    expect(sent).toHaveLength(1);
  });
});

const API_SECRET = "s".repeat(32);
const CAPABILITY = mintCapability({ id: "k1", secret: API_SECRET }, PAYMENT_KEY, "c".repeat(43));

/** The API router over a stub controller, so only the surface is under test. */
async function startApiRouter(): Promise<{
  base: string;
  calls: Array<{ sessionId: string; body: Record<string, unknown> }>;
}> {
  const calls: Array<{ sessionId: string; body: Record<string, unknown> }> = [];
  const view = {
    sessionId: SESSION_ID,
    state: "READY",
    tier: "short",
    durationSeconds: 60,
    limits: {},
    createdAt: Date.now(),
    remainingSeconds: 60,
    clientNonce: "d".repeat(43),
    clientPublicKey: "e".repeat(43),
    capabilityHash: sha256Hex(CAPABILITY),
    capabilityExpiresAt: Date.now() + 60_000,
    busy: false,
  };
  const config = loadConfig({
    PAYMENT_MODE: "mock",
    ALLOW_INSECURE_DEV: "true",
    CONTROLLER_ADMIN_TOKEN: "a".repeat(32),
    CAPABILITY_SECRET: API_SECRET,
    CAPABILITY_KEY_ID: "k1",
  });
  const controller = {
    async getSession() {
      return view;
    },
    async operation(sessionId: string, body: Record<string, unknown>) {
      calls.push({ sessionId, body });
      return { state: "ACTIVE", requestId: body.requestId, envelope: ENVELOPE_A };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createSessionsRouter({ config, controller } as never));
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, calls };
}

describe("operation idempotency binding on the API surface", () => {
  it("forwards the hash on the GET path, so a re-sealed request stays idempotent", async () => {
    const { base, calls } = await startApiRouter();
    const payloadHash = "b".repeat(64);
    const url = (request: string) =>
      `${base}/v1/sessions/${SESSION_ID}/operations?request=${encodeURIComponent(request)}` +
      `&requestId=${REQUEST_ID}&payloadHash=${payloadHash}&waitMs=0`;

    for (const request of [ENVELOPE_A, ENVELOPE_B]) {
      const res = await fetch(url(request), { headers: { "x-sandbox-capability": CAPABILITY } });
      expect(res.status).toBe(200);
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({ requestId: REQUEST_ID, payloadHash });
    expect(calls[1]!.body).toMatchObject({ requestId: REQUEST_ID, payloadHash });
    // Different ciphertext, same forwarded hash: the controller can tell this is
    // a retry rather than a reuse.
    expect(calls[0]!.body.envelope).not.toBe(calls[1]!.body.envelope);
  });

  it("refuses a malformed hash on the GET path instead of ignoring it", async () => {
    const { base, calls } = await startApiRouter();
    const res = await fetch(
      `${base}/v1/sessions/${SESSION_ID}/operations?request=${encodeURIComponent(ENVELOPE_A)}` +
        `&requestId=${REQUEST_ID}&payloadHash=not-a-hash`,
      { headers: { "x-sandbox-capability": CAPABILITY } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_payload_hash" });
    expect(calls).toHaveLength(0);
  });
});

describe("SDK payload hash", () => {
  it("hashes the canonical operation, not the envelope, so a re-seal retries", async () => {
    const guest = await generateBoxKeyPair();
    const clientKeys = await generateBoxKeyPair();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      const envelope = await sealJsonTo(clientKeys.publicKey, {
        v: 2,
        sessionId: SESSION_ID,
        clientNonce: "n".repeat(43),
        requestId: body.requestId,
        op: "exec",
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        cancelled: false,
      });
      return new Response(JSON.stringify({ envelope }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const sdk = new SandboxClient({ apiUrl: "http://api.test", paymentMode: "mock", allowInsecureDev: true });
    const handle = {
      sessionId: SESSION_ID,
      capability: "c".repeat(24),
      clientPublicKey: clientKeys.publicKey,
      clientPrivateKey: clientKeys.privateKey,
      clientNonce: "n".repeat(43),
      guestPublicKey: guest.publicKey,
      createdAt: 0,
    } satisfies SessionHandle;

    expect((await sdk.exec(handle, { command: ["true"], requestId: REQUEST_ID })).ok).toBe(true);
    expect((await sdk.exec(handle, { command: ["true"], requestId: REQUEST_ID })).ok).toBe(true);
    // A different command under the same id is a different operation.
    await sdk.exec(handle, { command: ["false"], requestId: REQUEST_ID });

    expect(bodies).toHaveLength(3);
    expect(bodies[0]!.envelope).not.toBe(bodies[1]!.envelope);
    expect(bodies[0]!.payloadHash).toBe(bodies[1]!.payloadHash);
    expect(bodies[2]!.payloadHash).not.toBe(bodies[0]!.payloadHash);
    expect(bodies[0]!.payloadHash).toBe(
      sha256Hex(
        canonicalJson({
          v: 2,
          sessionId: SESSION_ID,
          clientNonce: "n".repeat(43),
          requestId: REQUEST_ID,
          op: "exec",
          command: ["true"],
        }),
      ),
    );
  });
});
