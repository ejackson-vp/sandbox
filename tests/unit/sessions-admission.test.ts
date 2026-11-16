/**
 * Session route admission and lifecycle answers.
 *
 * `sessions-errors.test.ts` owns controller-failure mapping and
 * `sessions-capability-rotation.test.ts` owns the key ring. What is left is the
 * admission decision itself and the answers that only the happy-ish paths
 * produce: what an unauthenticated caller gets, what an expired capability gets,
 * that a read burst is bounded, that a suspended session refuses operations
 * before the payment-only envelope is parsed, and that suspend/resume/destroy
 * report the controller's own state.
 *
 * These are security behaviours, so they run the real router over a real
 * listener: a regression in the router, not just in a helper, has to fail.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintCapability } from "../../shared/src/entries/crypto.js";
import { sha256Hex } from "../../shared/src/crypto.js";
import { loadConfig, type ApiConfig } from "../../api/src/config.js";
import { ControllerError } from "../../api/src/controller-client.js";
import { createSessionsRouter } from "../../api/src/routes/sessions.js";

const SESSION_ID = "sbx_0123456789abcdef";
const SECRET = "s".repeat(32);
const PAYMENT_KEY = "0x" + "a".repeat(64);
const COMMITMENT = `${"c".repeat(43)}:${"d".repeat(43)}`;
const TOKEN = mintCapability({ id: "k1", secret: SECRET }, PAYMENT_KEY, COMMITMENT);
const REQUEST_ID = "req-0123456789";
/** Standard base64 of a sealed envelope; the API never looks inside it. */
const ENVELOPE = "c2VhbGVkLWVudmVsb3Bl";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  vi.restoreAllMocks();
});

function config(env: Record<string, string> = {}): ApiConfig {
  return loadConfig({
    PAYMENT_MODE: "mock",
    ALLOW_INSECURE_DEV: "true",
    CONTROLLER_ADMIN_TOKEN: "a".repeat(32),
    CAPABILITY_SECRET: SECRET,
    ...env,
  });
}

/** The view the router authorises against, tweakable per test. */
function view(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    state: "READY",
    tier: "short",
    durationSeconds: 60,
    limits: {},
    createdAt: Date.now(),
    remainingSeconds: 60,
    clientNonce: "d".repeat(43),
    clientPublicKey: "c".repeat(43),
    capabilityHash: sha256Hex(TOKEN),
    capabilityExpiresAt: Date.now() + 60_000,
    busy: false,
    payment: {
      paymentKey: PAYMENT_KEY,
      network: "mock:local",
      scheme: "exact",
      asset: "mock:usdc",
      amount: "50000",
      payTo: "0x0000000000000000000000000000000000000402",
      mode: "mock",
    },
    ...overrides,
  };
}

async function listen(
  opts: {
    env?: Record<string, string>;
    session?: () => unknown;
    controller?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const controller = {
    getSession: vi.fn(async () => opts.session?.() ?? view()),
    operation: vi.fn(async () => ({ state: "READY", requestId: REQUEST_ID, envelope: "AAAA" })),
    getOperation: vi.fn(async () => ({ state: "READY", requestId: REQUEST_ID, envelope: "AAAA" })),
    cancelOperation: vi.fn(async () => undefined),
    suspend: vi.fn(async () => view({ state: "SUSPENDED" })),
    resume: vi.fn(async () => view({ state: "RESUMING" })),
    destroy: vi.fn(async () => ({ state: "TERMINATING" })),
    wake: vi.fn(async () => undefined),
    ...opts.controller,
  };
  const app = express();
  app.use(express.json());
  app.use(createSessionsRouter({ config: config(opts.env), controller } as never));
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function call(
  base: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: { capability?: string | null; body?: unknown } = {},
) {
  const capability = opts.capability === undefined ? TOKEN : opts.capability;
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(capability ? { "x-sandbox-capability": capability } : {}),
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
}

describe("capability admission", () => {
  it("refuses a request with no capability", async () => {
    const base = await listen();
    const res = await call(base, "GET", `/v1/sessions/${SESSION_ID}`, { capability: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "capability_required" });
  });

  it("refuses a capability that is too short to be one, before any lookup", async () => {
    const getSession = vi.fn(async () => view());
    const base = await listen({ controller: { getSession } });
    const res = await call(base, "GET", `/v1/sessions/${SESSION_ID}`, { capability: "short" });
    expect(res.status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("answers 404 for a session the controller does not know", async () => {
    const base = await listen({
      controller: {
        getSession: vi.fn(async () => {
          throw new ControllerError(404, "session_not_found", "no such session");
        }),
      },
    });
    const res = await call(base, "GET", `/v1/sessions/${SESSION_ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session_not_found" });
  });

  it("hides a session whose stored hash is for a different capability", async () => {
    const base = await listen({ session: () => view({ capabilityHash: "e".repeat(64) }) });
    const res = await call(base, "GET", `/v1/sessions/${SESSION_ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session_not_found" });
  });

  it("reports an expired capability as 410, not as a missing session", async () => {
    const base = await listen({ session: () => view({ capabilityExpiresAt: Date.now() - 1 }) });
    const res = await call(base, "GET", `/v1/sessions/${SESSION_ID}`);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "capability_expired" });
  });

  it("bounds a read burst per client", async () => {
    const base = await listen({ env: { READ_RATE_BURST: "1", READ_RATE_REFILL: "1" } });
    expect((await call(base, "GET", `/v1/sessions/${SESSION_ID}`)).status).toBe(200);
    const limited = await call(base, "GET", `/v1/sessions/${SESSION_ID}`);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });
});

describe("operations", () => {
  it("refuses an operation on a suspended session before reading the body", async () => {
    const operation = vi.fn(async () => ({ state: "READY", requestId: REQUEST_ID }));
    const base = await listen({ session: () => view({ state: "SUSPENDED" }), controller: { operation } });
    const res = await call(base, "POST", `/v1/sessions/${SESSION_ID}/operations`, {
      body: { requestId: REQUEST_ID, envelope: ENVELOPE },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "session_suspended" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("answers 202 with the pending marker when the controller is still working", async () => {
    const base = await listen({
      controller: {
        operation: vi.fn(async () => ({ state: "READY", requestId: REQUEST_ID, pending: true })),
      },
    });
    const res = await call(base, "POST", `/v1/sessions/${SESSION_ID}/operations`, {
      body: { requestId: REQUEST_ID, envelope: ENVELOPE },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ state: "READY", requestId: REQUEST_ID, pending: true });
  });

  it("rejects a plaintext command field instead of forwarding it", async () => {
    const operation = vi.fn(async () => ({ state: "READY", requestId: REQUEST_ID }));
    const base = await listen({ controller: { operation } });
    const res = await call(base, "POST", `/v1/sessions/${SESSION_ID}/operations`, {
      body: { requestId: REQUEST_ID, envelope: ENVELOPE, command: ["cat", "/etc/shadow"] },
    });
    expect(res.status).toBe(400);
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects a read whose envelope is not standard base64", async () => {
    const base = await listen();
    const res = await call(
      base,
      "GET",
      `/v1/sessions/${SESSION_ID}/operations?request=${encodeURIComponent("c2VhbGVk-_YQ")}&requestId=${REQUEST_ID}`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_envelope_encoding" });
  });

  it("rejects a read with no envelope", async () => {
    const base = await listen();
    const res = await call(base, "GET", `/v1/sessions/${SESSION_ID}/operations?requestId=${REQUEST_ID}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "request_envelope_required" });
  });

  it("rejects a request id that is not one, on every surface that takes it", async () => {
    const base = await listen();
    for (const [method, path] of [
      ["GET", `/v1/sessions/${SESSION_ID}/requests/not%20a%20request`],
      ["DELETE", `/v1/sessions/${SESSION_ID}/requests/not%20a%20request`],
    ] as const) {
      const res = await call(base, method, path);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request_id" });
    }
  });

  it("clamps a poll wait so the edge proxy cannot time out first", async () => {
    const getOperation = vi.fn(async () => ({ state: "READY", requestId: REQUEST_ID }));
    const base = await listen({ controller: { getOperation } });
    await call(base, "GET", `/v1/sessions/${SESSION_ID}/requests/${REQUEST_ID}?waitMs=600000`);
    expect(getOperation).toHaveBeenCalledWith(SESSION_ID, REQUEST_ID, 90_000);
  });

  it("defaults the poll wait when the query value is not a number", async () => {
    const getOperation = vi.fn(async () => ({ state: "READY", requestId: REQUEST_ID }));
    const base = await listen({ controller: { getOperation } });
    await call(base, "GET", `/v1/sessions/${SESSION_ID}/requests/${REQUEST_ID}?waitMs=soon`);
    expect(getOperation).toHaveBeenCalledWith(SESSION_ID, REQUEST_ID, 20_000);
  });

  it("accepts a cancelled request with 202 and the request id", async () => {
    const base = await listen();
    const res = await call(base, "DELETE", `/v1/sessions/${SESSION_ID}/requests/${REQUEST_ID}`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, requestId: REQUEST_ID });
  });
});

describe("lifecycle answers", () => {
  it("returns the public status after a suspend", async () => {
    const base = await listen();
    const res = await call(base, "POST", `/v1/sessions/${SESSION_ID}/suspend`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sessionId: SESSION_ID, state: "SUSPENDED" });
  });

  it("answers 202 for a resume and nudges the controller without waiting for it", async () => {
    const wake = vi.fn(async () => undefined);
    const base = await listen({ controller: { wake } });
    const res = await call(base, "POST", `/v1/sessions/${SESSION_ID}/resume`);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ state: "RESUMING" });
    expect(wake).toHaveBeenCalled();
  });

  it("reports the destroy transition and does not fail when the nudge fails", async () => {
    const wake = vi.fn(async () => {
      throw new Error("controller is busy");
    });
    const base = await listen({ controller: { wake } });
    const res = await call(base, "DELETE", `/v1/sessions/${SESSION_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "TERMINATING" });
  });

  it("answers 503 when a destroy cannot reach the controller", async () => {
    const base = await listen({
      controller: {
        destroy: vi.fn(async () => {
          throw new Error("connect ECONNREFUSED 10.0.0.7:3001");
        }),
      },
    });
    const res = await call(base, "DELETE", `/v1/sessions/${SESSION_ID}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "control_plane_unavailable" });
  });
});
