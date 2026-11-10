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

async function request(
  sessionId: string,
  id: string,
  envelope: string,
  epoch?: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await admin(`/internal/${encodeURIComponent(sessionId)}/request`, {
    method: "POST",
    body: JSON.stringify({ id, envelope, deadlineMs: Date.now() + 30_000, ...(epoch === undefined ? {} : { epoch }) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("execution status and epoch forwarding", () => {
  it("tracks the guest's slot and forwards the controller's fence epoch", async () => {
    const sessionId = "sbx_relay_fence";
    await register(sessionId);
    const ws = await connect(sessionId);
    try {
      ws.send(JSON.stringify({ type: "status", activeRequestId: "req-active", epoch: 3 }));
      const deadline = Date.now() + 5_000;
      let current = await state(sessionId) as { statusAt?: number; activeRequestId?: string; execEpoch?: number };
      while (current.statusAt === undefined && Date.now() < deadline) {
        await sleep(25);
        current = (await state(sessionId)) as typeof current;
      }
      expect(current).toMatchObject({ activeRequestId: "req-active", execEpoch: 3 });
      expect(typeof current.statusAt).toBe("number");

      const frame = nextMessage(ws);
      expect((await request(sessionId, "request-fenced-1", "envelope", 7)).status).toBe(202);
      expect(await frame).toMatchObject({ type: "request", id: "request-fenced-1", epoch: 7 });

      ws.send(JSON.stringify({ type: "status", activeRequestId: "", epoch: 7 }));
      const idleDeadline = Date.now() + 5_000;
      let idle = (await state(sessionId)) as typeof current;
      while (idle.activeRequestId !== "" && Date.now() < idleDeadline) {
        await sleep(25);
        idle = (await state(sessionId)) as typeof current;
      }
      expect(idle).toMatchObject({ activeRequestId: "", execEpoch: 7 });
    } finally {
      ws.close();
    }
  });
});

describe("relay generation", () => {
  it("answers readiness without exposing registry state", async () => {
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("reports a stable per-process generation from /healthz", async () => {
    const first = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; generation: string };
    const second = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; generation: string };
    expect(first.ok).toBe(true);
    expect(first.generation).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.generation).toBe(first.generation);
    expect(relay.generation).toBe(first.generation);
  });

  it("assigns a different generation to a replacement relay", async () => {
    const replacement = createRelay({ adminToken: ADMIN });
    try {
      expect(replacement.generation).not.toBe(relay.generation);
    } finally {
      await replacement.close();
    }
  });

  it("rejects a registration aimed at a previous generation", async () => {
    const sessionId = "sbx_relay_stale_generation";
    const res = await admin("/internal/register", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        tokenHash: sha256Hex(TOKEN),
        ttlMs: 60_000,
        generation: "00000000-0000-4000-8000-000000000000",
      }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "relay_generation_changed",
      generation: relay.generation,
    });
    expect((await state(sessionId)).connected).toBe(false);

    const current = await admin("/internal/register", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        tokenHash: sha256Hex(TOKEN),
        ttlMs: 60_000,
        generation: relay.generation,
      }),
    });
    expect(current.status).toBe(201);
    expect(await current.json()).toMatchObject({ ok: true, generation: relay.generation });
  });
});

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
