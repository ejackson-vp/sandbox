/**
 * The exec wait is capped below the edge proxy timeout.
 *
 * The public API is behind a proxy that answers `524` for a request still open
 * at 100 seconds. If the API waits longer than that, the client gets the proxy's
 * timeout instead of the API's `202 pending`, so it never learns the request id
 * to re-poll and the paid session burns its lease with no usable answer.
 *
 * Two properties keep the client on the right side of that line: the schema
 * rejects a `waitMs` above the cap, and the default computed from a command
 * timeout is clamped to the same cap. The poll route clamps too, because the
 * re-poll is the same proxied request shape.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../shared/src/entries/crypto.js";
import { mintCapability } from "../../shared/src/capability.js";
import { loadConfig } from "../../api/src/config.js";
import { operationSchema } from "../../api/src/schemas.js";
import { createSessionsRouter } from "../../api/src/routes/sessions.js";

/** The cap under test. Kept as a literal so a change to the source is visible here. */
const WAIT_CAP_MS = 90_000;
const EDGE_TIMEOUT_MS = 100_000;

const SESSION_ID = `sbx_${"9".repeat(24)}`;
const REQUEST_ID = "wait-cap-request-0001";
const PAYMENT_KEY = "a".repeat(64);
const API_SECRET = "s".repeat(32);
const CAPABILITY = mintCapability({ id: "k1", secret: API_SECRET }, PAYMENT_KEY, "c".repeat(43));

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface Harness {
  base: string;
  /** `waitMs` forwarded to the controller, in call order. */
  waits: number[];
}

/** The API router over a stub controller, so only the surface is under test. */
async function startApi(): Promise<Harness> {
  const waits: number[] = [];
  const view = {
    sessionId: SESSION_ID,
    state: "READY",
    tier: "standard",
    durationSeconds: 300,
    limits: {},
    createdAt: Date.now(),
    remainingSeconds: 300,
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
    async operation(_sessionId: string, body: Record<string, unknown>) {
      waits.push(body.waitMs as number);
      return { state: "ACTIVE", requestId: body.requestId, envelope: "AAAA" };
    },
    async getOperation(_sessionId: string, requestId: string, waitMs: number) {
      waits.push(waitMs);
      return { pending: true, state: "ACTIVE", requestId };
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
  return { base, waits };
}

function post(base: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/v1/sessions/${SESSION_ID}/operations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sandbox-capability": CAPABILITY },
    body: JSON.stringify({ requestId: REQUEST_ID, envelope: "AAAA", ...body }),
  });
}

describe("waitMs schema cap", () => {
  it("accepts the cap and rejects anything above it", () => {
    const parse = (waitMs: number) =>
      operationSchema.safeParse({ requestId: REQUEST_ID, envelope: "AAAA", waitMs }).success;

    expect(parse(0)).toBe(true);
    expect(parse(WAIT_CAP_MS)).toBe(true);
    expect(parse(WAIT_CAP_MS + 1)).toBe(false);
    // The value the API used to accept, and the one the edge proxy kills.
    expect(parse(120_000)).toBe(false);
  });

  it("keeps the cap below the edge proxy timeout", () => {
    expect(WAIT_CAP_MS).toBeLessThan(EDGE_TIMEOUT_MS);
  });

  it("answers 400 for a request that asks to wait past the cap", async () => {
    const { base, waits } = await startApi();
    const res = await post(base, { waitMs: WAIT_CAP_MS + 1 });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    // Never forwarded: the controller must not hold the request open.
    expect(waits).toHaveLength(0);
  });
});

describe("default wait for a long command", () => {
  it("clamps a 300 second command to the cap instead of the old 120 s", async () => {
    const { base, waits } = await startApi();
    const res = await post(base, { timeoutMs: 300_000 });

    expect(res.status).toBe(200);
    expect(waits).toEqual([WAIT_CAP_MS]);
  });

  it("still uses timeout plus five seconds when that is under the cap", async () => {
    const { base, waits } = await startApi();
    const res = await post(base, { timeoutMs: 30_000 });

    expect(res.status).toBe(200);
    expect(waits).toEqual([35_000]);
  });
});

describe("poll wait", () => {
  it("clamps a requested poll wait to the same cap", async () => {
    const { base, waits } = await startApi();
    const res = await fetch(
      `${base}/v1/sessions/${SESSION_ID}/requests/${REQUEST_ID}?waitMs=120000`,
      { headers: { "x-sandbox-capability": CAPABILITY } },
    );

    expect(res.status).toBe(202);
    expect(waits).toEqual([WAIT_CAP_MS]);
  });
});
