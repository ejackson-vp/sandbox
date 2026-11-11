/**
 * Relay control listener mTLS (#23).
 *
 * The control routes exist only on the TLS listener and require a client
 * certificate with CN=controller. The guest WebSocket listener and the
 * relay -> controller wake token path are unchanged.
 */
import http from "node:http";
import type { AddressInfo, Server as NetServer } from "node:net";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent, fetch as undiciFetch } from "undici";
import WebSocket from "ws";
import { createRelay, type RelayServer } from "../../controller/src/relay.js";
import { RelayClient } from "../../controller/src/relay-client.js";
import { sha256Hex } from "../../controller/src/secrets.js";
import type { WarmClaim } from "@x402s/shared/protocol";
import { makeTestPki, type TestPki } from "../helpers/tls.js";

const ADMIN = "relay-admin-token-0123456789";
const TOKEN = "guest-token-0123456789";

let pki: TestPki;
let relay: RelayServer;
let guestPort: number;
let controlPort: number;
let client: RelayClient;

function listen(server: NetServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

beforeAll(async () => {
  pki = makeTestPki();
  relay = createRelay({
    adminToken: ADMIN,
    responseTtlMs: 30_000,
    controlTls: { certFile: pki.serverCertFile, keyFile: pki.serverKeyFile, caFile: pki.caFile },
  });
  guestPort = await listen(relay.server);
  if (!relay.controlServer) throw new Error("control listener missing");
  controlPort = await listen(relay.controlServer);
  client = new RelayClient({
    baseUrl: `https://127.0.0.1:${controlPort}`,
    adminToken: ADMIN,
    tls: { certFile: pki.clientCertFile, keyFile: pki.clientKeyFile, caFile: pki.caFile },
  });
});

afterAll(async () => {
  await relay?.close();
});

async function state(
  sessionId: string,
): Promise<{ connected: boolean; attestation?: unknown; generation?: string }> {
  return (await client.state(sessionId)) as unknown as {
    connected: boolean;
    attestation?: unknown;
    generation?: string;
  };
}

async function connectGuest(sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${guestPort}/guest?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(TOKEN)}`,
  );
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

describe("mTLS control listener", () => {
  it("registers, probes, reads state and purges over the client certificate", async () => {
    const sessionId = "sbx_mtls_register";
    const registered = await client.registerCurrent(sessionId, sha256Hex(TOKEN), 60_000, { deadlineMs: 2_000 });
    expect(registered.generation).toBe(relay.generation);

    const health = await client.health();
    expect(health.generation).toBe(relay.generation);
    const snapshot = await state(sessionId);
    expect(snapshot.connected).toBe(false);
    expect(snapshot.generation).toBe(relay.generation);

    await client.purge(sessionId);
    const gone = await client.state(sessionId);
    expect((gone as unknown as { registered: boolean }).registered).toBe(false);
  });

  it("rejects a plaintext client on the control port", async () => {
    await expect(
      fetch(`http://127.0.0.1:${controlPort}/internal/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": ADMIN },
        body: JSON.stringify({ sessionId: "sbx_plaintext", tokenHash: "hash", ttlMs: 60_000 }),
      }),
    ).rejects.toThrow();
  });

  it("does not expose control routes on the plaintext guest listener", async () => {
    const res = await fetch(`http://127.0.0.1:${guestPort}/internal/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": ADMIN },
      body: JSON.stringify({ sessionId: "sbx_guest_plain", tokenHash: "hash", ttlMs: 60_000 }),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("generation");
  });

  it("rejects a CA-signed client with the wrong CN at the TLS layer", async () => {
    const wrongCn = new Agent({
      connect: {
        cert: readFileSync(pki.wrongCnCertFile),
        key: readFileSync(pki.wrongCnKeyFile),
        ca: readFileSync(pki.caFile),
      },
    });
    try {
      await expect(
        undiciFetch(`https://127.0.0.1:${controlPort}/internal/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "sbx_wrong_cn", tokenHash: "hash", ttlMs: 60_000 }),
          dispatcher: wrongCn,
        } as Parameters<typeof undiciFetch>[1]),
      ).rejects.toThrow();
      // The request never reached a route.
      const state = await client.state("sbx_wrong_cn");
      expect((state as unknown as { registered: boolean }).registered).toBe(false);
    } finally {
      await wrongCn.close();
    }
  });

  it("rejects a TLS client with no certificate even when it sends the token", async () => {
    // The old shared secret is not a bypass: the handshake requires a client
    // certificate before any route or header is examined.
    await expect(
      undiciFetch(`https://127.0.0.1:${controlPort}/internal/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": ADMIN },
        body: JSON.stringify({ sessionId: "sbx_no_cert", tokenHash: "hash", ttlMs: 60_000 }),
        dispatcher: new Agent({ connect: { ca: readFileSync(pki.caFile) } }),
      } as Parameters<typeof undiciFetch>[1]),
    ).rejects.toThrow();
  });

  it("forwards requests and responses over mTLS while the guest stays on plaintext WS", async () => {
    const sessionId = "sbx_mtls_roundtrip";
    await client.register(sessionId, sha256Hex(TOKEN), 60_000);
    const ws = await connectGuest(sessionId);
    try {
      const id = "request-mtls-1";
      const frame = nextMessage(ws);
      await client.request(sessionId, id, "envelope", Date.now() + 30_000);
      expect(await frame).toMatchObject({ type: "request", id, envelope: "envelope" });

      ws.send(JSON.stringify({ type: "response", id, envelope: "result-one" }));
      const response = await client.response(sessionId, id, 5_000);
      expect(response).toEqual({ kind: "envelope", envelope: "result-one" });

      // Warm-pool claim travels over the same certificate-authenticated path.
      const claimFrame = nextMessage(ws);
      await client.claim(sessionId, { sessionId: "sbx_claimed" } as WarmClaim);
      expect(await claimFrame).toMatchObject({ type: "claim", claim: { sessionId: "sbx_claimed" } });
    } finally {
      ws.terminate();
      await client.purge(sessionId);
    }
  });
});

describe("wake token path", () => {
  it("keeps the relay -> controller wake over plaintext with the low-privilege token", async () => {
    const wakes: Array<{ token?: string; method?: string; url?: string }> = [];
    const controller = http.createServer((req, res) => {
      wakes.push({ token: req.headers["x-wake-token"] as string | undefined, method: req.method, url: req.url });
      res.writeHead(202, { "content-type": "application/json" });
      res.end("{}");
    });
    const controllerPort = await listen(controller);
    const wakeRelay = createRelay({
      adminToken: ADMIN,
      controllerUrl: `http://127.0.0.1:${controllerPort}`,
      wakeToken: "wake-token-0123456789",
      controlTls: { certFile: pki.serverCertFile, keyFile: pki.serverKeyFile, caFile: pki.caFile },
    });
    try {
      const wakeGuestPort = await listen(wakeRelay.server);
      if (!wakeRelay.controlServer) throw new Error("control listener missing");
      const wakeControlPort = await listen(wakeRelay.controlServer);
      const wakeClient = new RelayClient({
        baseUrl: `https://127.0.0.1:${wakeControlPort}`,
        adminToken: ADMIN,
        tls: { certFile: pki.clientCertFile, keyFile: pki.clientKeyFile, caFile: pki.caFile },
      });
      await wakeClient.register("sbx_mtls_wake", sha256Hex(TOKEN), 60_000);
      const ws = new WebSocket(
        `ws://127.0.0.1:${wakeGuestPort}/guest?session=sbx_mtls_wake&token=${encodeURIComponent(TOKEN)}`,
      );
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      ws.send(JSON.stringify({ type: "hello", evidence: { sessionId: "sbx_mtls_wake", evidenceType: "dev-simulated", insecureDevOnly: true } }));

      const deadline = Date.now() + 5_000;
      while (wakes.length === 0 && Date.now() < deadline) await sleep(25);
      expect(wakes[0]).toMatchObject({
        method: "POST",
        url: "/internal/wake",
        token: "wake-token-0123456789",
      });
      ws.terminate();
    } finally {
      await wakeRelay.close();
      await new Promise<void>((resolve) => controller.close(() => resolve()));
    }
  });
});
