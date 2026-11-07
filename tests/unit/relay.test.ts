import { setTimeout as sleep } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createRelay, type RelayServer } from "../../controller/src/relay.js";
import { sha256Hex } from "../../controller/src/tokens.js";

const ADMIN = "relay-admin-token-0123456789";
const TOKEN = "guest-token-0123456789";

let relay: RelayServer;
let base: string;
let port: number;

beforeEach(async () => {
  relay = createRelay({ adminToken: ADMIN, responseTtlMs: 30_000 });
  await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  port = (relay.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await relay.close();
});

async function admin(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-internal-token": ADMIN,
      ...(init.headers ?? {}),
    },
  });
}

async function register(sessionId: string): Promise<void> {
  const res = await admin("/internal/register", {
    method: "POST",
    body: JSON.stringify({ sessionId, tokenHash: sha256Hex(TOKEN), ttlMs: 60_000 }),
  });
  expect(res.status).toBe(201);
}

async function state(sessionId: string): Promise<{ connected: boolean; attestation?: unknown }> {
  const res = await admin(`/internal/${encodeURIComponent(sessionId)}/state`);
  return (await res.json()) as { connected: boolean; attestation?: unknown };
}

async function connect(sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/guest?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(TOKEN)}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "hello", evidence: { sessionId, evidenceType: "dev-simulated", insecureDevOnly: true } }));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await state(sessionId)).attestation) return ws;
    await sleep(25);
  }
  throw new Error("relay did not record hello");
}

function nextMessage(ws: WebSocket, timeoutMs = 2_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timed out waiting for a relay frame"));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData): void => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    };
    ws.on("message", onMessage);
  });
}

async function expectNoMessage(ws: WebSocket, waitMs = 200): Promise<void> {
  let received = false;
  const onMessage = (): void => {
    received = true;
  };
  ws.on("message", onMessage);
  await sleep(waitMs);
  ws.off("message", onMessage);
  expect(received).toBe(false);
}

async function request(sessionId: string, id: string, envelope: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await admin(`/internal/${encodeURIComponent(sessionId)}/request`, {
    method: "POST",
    body: JSON.stringify({ id, envelope, deadlineMs: Date.now() + 30_000 }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("relay idempotency", () => {
  it("does not re-execute a completed request and keeps the first response", async () => {
    const sessionId = "sbx_relay_completed";
    await register(sessionId);
    const ws = await connect(sessionId);
    try {
      const id = "request-completed-1";
      const frame = nextMessage(ws);
      const first = await request(sessionId, id, "first-envelope");
      expect(first.status).toBe(202);
      expect(await frame).toMatchObject({ type: "request", id, envelope: "first-envelope" });

      ws.send(JSON.stringify({ type: "response", id, envelope: "result-one" }));
      const result = await admin(`/internal/${encodeURIComponent(sessionId)}/response/${id}`);
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ envelope: "result-one" });

      // A delayed duplicate must not replace the delivered result.
      ws.send(JSON.stringify({ type: "response", id, envelope: "result-two" }));
      await sleep(100);
      const still = await admin(`/internal/${encodeURIComponent(sessionId)}/response/${id}`);
      expect(await still.json()).toEqual({ envelope: "result-one" });

      // A retried request must not reach the guest again.
      const replay = await request(sessionId, id, "first-envelope");
      expect(replay.status).toBe(202);
      expect(replay.body.cached).toBe(true);
      await expectNoMessage(ws);
    } finally {
      ws.terminate();
    }
  });

  it("treats a retry of an in-flight request as pending without re-forwarding", async () => {
    const sessionId = "sbx_relay_pending";
    await register(sessionId);
    const ws = await connect(sessionId);
    try {
      const id = "request-pending-1";
      const frame = nextMessage(ws);
      expect((await request(sessionId, id, "envelope")).status).toBe(202);
      expect(await frame).toMatchObject({ type: "request", id });

      const replay = await request(sessionId, id, "envelope");
      expect(replay.status).toBe(202);
      expect(replay.body.pending).toBe(true);
      await expectNoMessage(ws);
    } finally {
      ws.terminate();
    }
  });

  it("keeps a guest error terminal for late and duplicate responses", async () => {
    const sessionId = "sbx_relay_error";
    await register(sessionId);
    const ws = await connect(sessionId);
    try {
      const id = "request-error-1";
      const frame = nextMessage(ws);
      expect((await request(sessionId, id, "envelope")).status).toBe(202);
      expect(await frame).toMatchObject({ type: "request", id });

      ws.send(JSON.stringify({ type: "error", id, code: "exec_failed", message: "command exploded" }));
      const failed = await admin(`/internal/${encodeURIComponent(sessionId)}/response/${id}`);
      expect(failed.status).toBe(409);
      expect(await failed.json()).toMatchObject({ error: "guest_error", message: "command exploded" });

      // A late success must not turn the recorded failure into success.
      ws.send(JSON.stringify({ type: "response", id, envelope: "late-result" }));
      await sleep(100);
      const still = await admin(`/internal/${encodeURIComponent(sessionId)}/response/${id}`);
      expect(still.status).toBe(409);
      expect(await still.json()).toMatchObject({ error: "guest_error", message: "command exploded" });

      const replay = await request(sessionId, id, "envelope");
      expect(replay.body.cached).toBe(true);
      await expectNoMessage(ws);
    } finally {
      ws.terminate();
    }
  });
});
