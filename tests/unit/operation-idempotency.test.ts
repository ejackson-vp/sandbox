/**
 * The operation idempotency key is bound to the envelope (schema v16).
 *
 * `requestId` alone is not enough: a client that reuses it for a different
 * operation must not receive the first operation's cached result. This file
 * pins the control API surface: a same-payload retry is an idempotent replay,
 * a different payload is `409 idempotency_key_reused` and never reaches the
 * relay or executes.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createControlApi } from "../../controller/src/control-api.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import { Store } from "../../controller/src/store.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import { seedReadySession } from "./store-contract/fixtures.js";

const PAYMENT_KEY = "a".repeat(64);
const SESSION_ID = `sbx_${"7".repeat(24)}`;
const REQUEST_ID = "idem-request-0001";

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
const stores: Store[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "x402-operation-idempotency-"));
  dirs.push(dir);
  return dir;
}

async function start(relay: RelayClient, store: Store): Promise<number> {
  const cfg = loadControllerConfig({
    ADMIN_TOKEN: "c".repeat(24),
    ROLE: "controller",
    KUBERNETES_ENABLED: "false",
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
    DB_PATH: join(tempDir(), "controller.db"),
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
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/internal/sessions/${SESSION_ID}/operations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": "c".repeat(24) },
    body: JSON.stringify({ requestId: REQUEST_ID, envelope, op: "exec", waitMs: 0 }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe("operation idempotency binding", () => {
  it("replays the cached result for the same payload and refuses a different one", async () => {
    const store = new Store(join(tempDir(), "controller.db"));
    stores.push(store);
    await seedReadySession(store, SESSION_ID, PAYMENT_KEY);
    const { relay, sent } = stubRelay();
    const port = await start(relay, store);

    const first = await operate(port, "c2VhbGVkLWVudmVsb3BlLUE=");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      requestId: REQUEST_ID,
      envelope: "c2VhbGVkLWVudmVsb3BlLUE=",
    });
    expect(sent).toHaveLength(1);

    // Same id, same payload: the cached result, not a second execution.
    const replay = await operate(port, "c2VhbGVkLWVudmVsb3BlLUE=");
    expect(replay.status).toBe(200);
    expect(replay.body.envelope).toBe("c2VhbGVkLWVudmVsb3BlLUE=");
    expect(sent).toHaveLength(1);

    // Same id, different payload: refused before the relay sees it, and the old
    // envelope is not handed back.
    const reused = await operate(port, "c2VhbGVkLWVudmVsb3BlLUI=");
    expect(reused.status).toBe(409);
    expect(reused.body).toEqual({ error: "idempotency_key_reused", requestId: REQUEST_ID });
    expect(sent).toHaveLength(1);
  });
});
