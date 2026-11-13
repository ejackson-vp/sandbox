import { setTimeout as sleep } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createRelay, type RelayServer } from "../../controller/src/relay.js";
import { sha256Hex } from "../../controller/src/secrets.js";

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

describe("relay execution-epoch floor", () => {
  async function raiseEpoch(sessionId: string, epoch: number): Promise<Response> {
    return admin(`/internal/${encodeURIComponent(sessionId)}/epoch`, {
      method: "POST",
      body: JSON.stringify({ epoch }),
    });
  }

  function nextClose(ws: WebSocket, timeoutMs = 5_000): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for the guest socket to close")), timeoutMs);
      ws.once("close", (code: number) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  it("withdraws a forwarded-but-unobserved frame and resets the guest connection", async () => {
    const sessionId = "sbx_relay_epoch_withdraw";
    await register(sessionId);
    const ws = await connect(sessionId);
    try {
      ws.send(JSON.stringify({ type: "status", activeRequestId: "", epoch: 1 }));
      const statusDeadline = Date.now() + 5_000;
      while ((await state(sessionId) as { statusAt?: number }).statusAt === undefined) {
        if (Date.now() > statusDeadline) throw new Error("guest status was not recorded");
        await sleep(25);
      }

      // The previous controller generation forwards the frame...
      const id = "request-before-recovery";
      const frame = nextMessage(ws);
      expect((await request(sessionId, id, "envelope", 1)).status).toBe(202);
      expect(await frame).toMatchObject({ type: "request", id, epoch: 1 });
      const closed = nextClose(ws);

      // ...then recovery bumps the session epoch and publishes it.
      const raised = await raiseEpoch(sessionId, 2);
      expect(raised.status).toBe(200);
      expect(await raised.json()).toMatchObject({ ok: true, epoch: 2, withdrawn: 1, reset: true });

      // The guest has not observed epoch 2, so the link is reset (1006) and the
      // queued frame is discarded rather than read.
      expect(await closed).toBe(1006);
      const current = await state(sessionId) as {
        connected: boolean;
        pending: number;
        epochFloor: number;
      };
      expect(current).toMatchObject({ connected: false, pending: 0, epochFloor: 2 });

      // The withdrawn frame is no longer in flight; a waiter is told it is not
      // pending rather than being left to time out.
      const withdrawn = await admin(`/internal/${encodeURIComponent(sessionId)}/response/${id}`);
      expect(withdrawn.status).toBe(202);
      expect(await withdrawn.json()).toEqual({ pending: false });

      // A frame from the superseded generation is refused at the relay.
      const stale = await request(sessionId, "request-stale-generation", "envelope", 1);
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({ error: "stale_epoch" });
    } finally {
      ws.terminate();
    }
  });

  it("keeps the guest link when it has already reported an epoch at or above the floor", async () => {
    const sessionId = "sbx_relay_epoch_observed";
    await register(sessionId);
    const ws = await connect(sessionId);
    try {
      ws.send(JSON.stringify({ type: "status", activeRequestId: "", epoch: 1 }));
      const id = "request-observed-before-recovery";
      const frame = nextMessage(ws);
      expect((await request(sessionId, id, "envelope", 1)).status).toBe(202);
      expect(await frame).toMatchObject({ type: "request", id, epoch: 1 });

      // The guest reports that it has already observed the newer generation.
      ws.send(JSON.stringify({ type: "status", activeRequestId: "", epoch: 2 }));
      const deadline = Date.now() + 5_000;
      while ((await state(sessionId) as { execEpoch?: number }).execEpoch !== 2) {
        if (Date.now() > deadline) throw new Error("guest epoch was not recorded");
        await sleep(25);
      }

      const observed = await raiseEpoch(sessionId, 2);
      expect(observed.status).toBe(200);
      expect(await observed.json()).toMatchObject({ ok: true, epoch: 2, withdrawn: 1, reset: false });
      const current = await state(sessionId) as {
        connected: boolean;
        pending: number;
        epochFloor: number;
      };
      expect(current).toMatchObject({ connected: true, pending: 0, epochFloor: 2 });

      // New work at the floor is forwarded on the surviving connection.
      const nextFrame = nextMessage(ws);
      expect((await request(sessionId, "request-after-recovery", "envelope", 2)).status).toBe(202);
      expect(await nextFrame).toMatchObject({ type: "request", id: "request-after-recovery", epoch: 2 });
    } finally {
      ws.terminate();
    }
  });

  it("is monotonic and survives re-registration", async () => {
    const sessionId = "sbx_relay_epoch_monotonic";
    await register(sessionId);
    expect((await raiseEpoch(sessionId, 3)).status).toBe(200);
    expect((await state(sessionId) as { epochFloor?: number }).epochFloor).toBe(3);
    expect((await raiseEpoch(sessionId, 2)).status).toBe(200);
    expect((await state(sessionId) as { epochFloor?: number }).epochFloor).toBe(3);

    await register(sessionId);
    expect((await state(sessionId) as { epochFloor?: number }).epochFloor).toBe(3);
  });

  it("accepts a reconnect on the same registration and still refuses a stale frame", async () => {
    const sessionId = "sbx_relay_reconnect";
    await register(sessionId);
    const first = await connect(sessionId);
    first.send(JSON.stringify({ type: "status", activeRequestId: "req-old", epoch: 1 }));
    const deadline = Date.now() + 5_000;
    while (!(await state(sessionId) as { statusAt?: number }).statusAt) {
      if (Date.now() > deadline) throw new Error("guest status was not recorded");
      await sleep(25);
    }

    // The relay process dies with the guest's socket: the registry is gone.
    first.terminate();
    await sleep(50);
    expect((await state(sessionId) as { connected: boolean }).connected).toBe(false);

    // Recovery publishes the bumped epoch before the session is re-registered.
    expect((await raiseEpoch(sessionId, 2)).status).toBe(200);
    expect((await request(sessionId, "request-below-floor", "envelope", 1)).status).toBe(409);

    // The replacement relay registers the same session with the same token hash
    // and accepts the reconnect.
    const replacement = createRelay({ adminToken: ADMIN, responseTtlMs: 30_000 });
    await new Promise<void>((resolve) => replacement.server.listen(port + 1, "127.0.0.1", resolve));
    const replacementBase = `http://127.0.0.1:${port + 1}`;
    try {
      const registered = await fetch(`${replacementBase}/internal/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": ADMIN },
        body: JSON.stringify({ sessionId, tokenHash: sha256Hex(TOKEN), ttlMs: 60_000 }),
      });
      expect(registered.status).toBe(201);

      const second = new WebSocket(
        `ws://127.0.0.1:${port + 1}/guest?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(TOKEN)}`,
      );
      await new Promise<void>((resolve, reject) => {
        second.once("open", resolve);
        second.once("error", reject);
      });
      try {
        second.send(
          JSON.stringify({
            type: "hello",
            evidence: { sessionId, evidenceType: "dev-simulated", insecureDevOnly: true },
          }),
        );
        const afterHello = Date.now() + 5_000;
        while (!(await (async () => {
          const res = await fetch(`${replacementBase}/internal/${sessionId}/state`, {
            headers: { "x-internal-token": ADMIN },
          });
          return res.json() as Promise<{ attestation?: unknown }>;
        })()).attestation) {
          if (Date.now() > afterHello) throw new Error("replacement relay did not record hello");
          await sleep(25);
        }

        // The new link starts with no execution status: the previous link's
        // report cannot release a recovery fence.
        const beforeStatus = (await (await fetch(`${replacementBase}/internal/${sessionId}/state`, {
          headers: { "x-internal-token": ADMIN },
        })).json()) as { statusAt?: number; connected: boolean };
        expect(beforeStatus.connected).toBe(true);
        expect(beforeStatus.statusAt).toBeUndefined();

        // The reconnected guest reports its surviving high-water mark and an
        // idle slot. That is what lets the controller's fence clear.
        second.send(JSON.stringify({ type: "status", activeRequestId: "", epoch: 1 }));
        const idle = Date.now() + 5_000;
        for (;;) {
          const res = (await (await fetch(`${replacementBase}/internal/${sessionId}/state`, {
            headers: { "x-internal-token": ADMIN },
          })).json()) as { statusAt?: number; activeRequestId?: string };
          if (res.activeRequestId === "" && res.statusAt !== undefined) break;
          if (Date.now() > idle) throw new Error("replacement relay did not record the idle status");
          await sleep(25);
        }

        // The epoch floor is per session, not per relay process: the controller
        // republishes it, and the relay then refuses a superseded frame.
        const raised = await fetch(`${replacementBase}/internal/${sessionId}/epoch`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": ADMIN },
          body: JSON.stringify({ epoch: 2 }),
        });
        expect(raised.status).toBe(200);
        const stale = await fetch(`${replacementBase}/internal/${sessionId}/request`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": ADMIN },
          body: JSON.stringify({ id: "request-after-reconnect", envelope: "envelope", deadlineMs: Date.now() + 5_000, epoch: 1 }),
        });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toMatchObject({ error: "stale_epoch" });

        const frame = nextMessage(second);
        const current = await fetch(`${replacementBase}/internal/${sessionId}/request`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": ADMIN },
          body: JSON.stringify({ id: "request-current-epoch", envelope: "envelope", deadlineMs: Date.now() + 5_000, epoch: 2 }),
        });
        expect(current.status).toBe(202);
        expect(await frame).toMatchObject({
          type: "request",
          id: "request-current-epoch",
          epoch: 2,
        });
      } finally {
        second.terminate();
      }
    } finally {
      await replacement.close();
    }
  });

  it("reports an unknown session and rejects an invalid epoch", async () => {
    expect((await raiseEpoch("sbx_relay_epoch_absent", 2)).status).toBe(404);
    const sessionId = "sbx_relay_epoch_validation";
    await register(sessionId);
    expect((await raiseEpoch(sessionId, 0)).status).toBe(400);
    expect((await raiseEpoch(sessionId, 1.5)).status).toBe(400);
  });
});

describe("relay generation", () => {
  it("rejects an unauthenticated control call on the plaintext fallback", async () => {
    const res = await fetch(`${base}/internal/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "sbx_no_token", tokenHash: sha256Hex(TOKEN), ttlMs: 60_000 }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

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
