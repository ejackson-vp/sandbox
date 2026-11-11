import { setTimeout as sleep } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createRelay, type RelayServer } from "../../controller/src/relay.js";
import { sha256Hex } from "../../controller/src/secrets.js";
import { MetricsRegistry } from "../../shared/src/metrics.js";

const ADMIN = "relay-admin-token-0123456789";
const TOKEN = "guest-token-0123456789";
const SESSION = "sbx_0123456789abcdef";

let relay: RelayServer | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

async function closeSocket(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close(1000, "done");
  });
}

describe("relay lifecycle metrics", () => {
  it("counts reconnects and bounded disconnect reasons without session ids", async () => {
    const metrics = new MetricsRegistry({ cacheMs: 0 });
    relay = createRelay({ adminToken: ADMIN, responseTtlMs: 30_000, metricsRegistry: metrics });
    await new Promise<void>((resolve) => relay!.server.listen(0, "127.0.0.1", resolve));
    const port = (relay.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const registered = await fetch(`${base}/internal/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": ADMIN },
      body: JSON.stringify({ sessionId: SESSION, tokenHash: sha256Hex(TOKEN), ttlMs: 60_000 }),
    });
    expect(registered.status).toBe(201);

    const url = `ws://127.0.0.1:${port}/guest?session=${SESSION}&token=${TOKEN}`;
    const first = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      first.once("open", () => resolve());
      first.once("error", reject);
    });
    await closeSocket(first);
    await sleep(25);

    const second = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      second.once("open", () => resolve());
      second.once("error", reject);
    });
    await closeSocket(second);
    await sleep(20);

    relay.collectMetrics();
    const text = metrics.render();
    expect(text).toContain("sandbox_relay_reconnects_total 1");
    expect(text).toContain('sandbox_relay_disconnects_total{reason="normal"} 2');
    expect(text).toContain("sandbox_relay_sessions 1");
    expect(text).not.toContain(SESSION);
  });
});
