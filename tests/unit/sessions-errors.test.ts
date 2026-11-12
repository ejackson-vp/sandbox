/**
 * Session route error mapping.
 *
 * Every session route reports a controller failure the same way: the
 * controller's status and code, 503 when the control plane is unreachable, and
 * 410 for a lease that ran out mid-operation. This runs the real router over a
 * real listener, so the shared helper and the routes that call it cannot drift.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintCapability } from "../../shared/src/entries/crypto.js";
import { sha256Hex } from "../../shared/src/crypto.js";
import { loadConfig } from "../../api/src/config.js";
import { ControllerError } from "../../api/src/controller-client.js";
import { createSessionsRouter } from "../../api/src/routes/sessions.js";

const SESSION_ID = "sbx_0123456789abcdef";
const SECRET = "s".repeat(32);
const PAYMENT_KEY = "0x" + "a".repeat(64);
const COMMITMENT = `${"c".repeat(43)}:${"d".repeat(43)}`;
const TOKEN = mintCapability({ id: "k1", secret: SECRET }, PAYMENT_KEY, COMMITMENT);
const REQUEST_ID = "req-0123456789";

const config = loadConfig({
  PAYMENT_MODE: "mock",
  ALLOW_INSECURE_DEV: "true",
  CONTROLLER_ADMIN_TOKEN: "a".repeat(32),
  CAPABILITY_SECRET: SECRET,
});

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  vi.restoreAllMocks();
});

/** The readiness view `authorize` accepts for TOKEN. */
function view() {
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
  };
}

async function listen(overrides: Record<string, unknown> = {}): Promise<string> {
  const controller = {
    getSession: vi.fn(async () => view()),
    operation: vi.fn(),
    getOperation: vi.fn(),
    cancelOperation: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    wake: vi.fn(async () => undefined),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use(createSessionsRouter({ config, controller } as never));
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function call(base: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "x-sandbox-capability": TOKEN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("controller failure mapping", () => {
  it("turns a lease that expired mid-operation into 410", async () => {
    const base = await listen({
      operation: vi.fn(async () => {
        throw new ControllerError(503, "lease_expired", "the session lease expired");
      }),
    });
    const res = await call(base, "POST", `/v1/sessions/${SESSION_ID}/operations`, {
      requestId: REQUEST_ID,
      envelope: "AAAA",
    });
    expect(res.status).toBe(410);
    expect(await body(res)).toEqual({
      error: "lease_expired",
      message: "the session lease expired",
    });
  });

  it("copies the controller's status and code on every other route", async () => {
    const busy = new ControllerError(409, "session_busy", "another operation is in flight");
    const base = await listen({
      operation: vi.fn(async () => {
        throw busy;
      }),
      getOperation: vi.fn(async () => {
        throw new ControllerError(404, "request_not_found", "no such request");
      }),
      cancelOperation: vi.fn(async () => {
        throw new ControllerError(410, "lease_expired", "gone");
      }),
    });

    const operation = await call(base, "POST", `/v1/sessions/${SESSION_ID}/operations`, {
      requestId: REQUEST_ID,
      envelope: "AAAA",
    });
    expect(operation.status).toBe(409);
    expect(await body(operation)).toEqual({
      error: "session_busy",
      message: "another operation is in flight",
    });

    const result = await call(base, "GET", `/v1/sessions/${SESSION_ID}/requests/${REQUEST_ID}`);
    expect(result.status).toBe(404);
    expect((await body(result)).error).toBe("request_not_found");

    const cancelled = await call(base, "DELETE", `/v1/sessions/${SESSION_ID}/requests/${REQUEST_ID}`);
    expect(cancelled.status).toBe(410);
    expect((await body(cancelled)).error).toBe("lease_expired");
  });

  it("keeps the file read's 410 status", async () => {
    const base = await listen({
      operation: vi.fn(async () => {
        throw new ControllerError(410, "lease_expired", "gone");
      }),
    });
    // file.get is the GET operations route: the envelope and request id are
    // valid, so the controller call is what refuses.
    const res = await call(
      base,
      "GET",
      `/v1/sessions/${SESSION_ID}/operations?request=AAAA&requestId=${REQUEST_ID}`,
    );
    expect(res.status).toBe(410);
    expect((await body(res)).error).toBe("lease_expired");
  });

  it("answers 503 for an unreachable controller without leaking the message", async () => {
    const failure = new Error("connect ECONNREFUSED 10.0.0.7:3001");
    const base = await listen({
      suspend: vi.fn(async () => {
        throw failure;
      }),
      resume: vi.fn(async () => {
        throw failure;
      }),
      getOperation: vi.fn(async () => {
        throw failure;
      }),
    });

    for (const [method, path] of [
      ["POST", `/v1/sessions/${SESSION_ID}/suspend`],
      ["POST", `/v1/sessions/${SESSION_ID}/resume`],
      ["GET", `/v1/sessions/${SESSION_ID}/requests/${REQUEST_ID}`],
    ] as const) {
      const res = await call(base, method, path);
      expect(res.status, `${method} ${path}`).toBe(503);
      const payload = await body(res);
      expect(payload).toEqual({ error: "control_plane_unavailable" });
      expect(JSON.stringify(payload)).not.toContain("10.0.0.7");
    }
  });
});
