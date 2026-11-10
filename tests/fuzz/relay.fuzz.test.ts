/**
 * Property and fuzz tests for the relay boundary.
 *
 * Three layers:
 *  - RelayRegistry: pure state machine. Arbitrary request ids and envelopes
 *    must never throw, and the pending/response caches must stay bounded.
 *  - The real relay HTTP surface: malformed JSON must produce a 4xx, never a
 *    500, and the 24 MiB frame cap must reject oversized envelopes.
 *  - A real guest WebSocket: arbitrary frames must either be ignored or close
 *    the connection with a protocol code; the relay process must stay healthy.
 */
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fuzzSeed } from "./seeds.js";
import WebSocket from "ws";
import { createRelay, type RelayServer } from "../../controller/src/relay.js";
import {
  MAX_FRAME_BYTES,
  MAX_PENDING,
  RelayRegistry,
} from "../../controller/src/relay/registry.js";
import { sha256Hex } from "../../controller/src/tokens.js";

const ADMIN = "relay-fuzz-admin-token-0123456789";
const TOKEN = "relay-fuzz-guest-token-0123456789";

function fakeSocket(): WebSocket {
  return { readyState: 1, send() {} } as unknown as WebSocket;
}

describe("RelayRegistry", () => {
  it("never throws for arbitrary request ids and keeps pending bounded", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ maxLength: 64 }),
            envelope: fc.string({ maxLength: 128 }),
            deadlineMs: fc.oneof(fc.integer(), fc.constant(undefined), fc.constant(null)),
          }),
          { maxLength: 64 },
        ),
        (requests) => {
          const registry = new RelayRegistry({ maxSessions: 4, responseTtlMs: 60_000 });
          expect(registry.register("sbx_relay_fuzz", "hash", 60_000)).toBe("ok");
          registry.attach("sbx_relay_fuzz", fakeSocket());
          for (const req of requests) {
            const result = registry.request(
              "sbx_relay_fuzz",
              req.id,
              req.envelope,
              req.deadlineMs as number | undefined,
            );
            expect(["sent", "cached", "pending", "too_many", "not_connected", "not_registered"]).toContain(result);
            expect(registry.pendingTotal()).toBeLessThanOrEqual(MAX_PENDING);
          }
        },
      ),
      { numRuns: 100, ...fuzzSeed },
    );
  });

  it("evicts old responses instead of growing the cache without bound", () => {
    const registry = new RelayRegistry({ maxSessions: 1, responseTtlMs: 60_000 });
    registry.register("sbx_relay_cache", "hash", 60_000);
    registry.attach("sbx_relay_cache", fakeSocket());
    for (let i = 0; i < 200; i += 1) {
      expect(registry.response("sbx_relay_cache", `request-${i}`, "e30=")).toBe("ok");
    }
    // The oldest entries are gone; re-requesting one must forward again
    // rather than replay a stale cached envelope (or grow without bound).
    expect(registry.request("sbx_relay_cache", "request-0", "e30=")).not.toBe("cached");
    expect(registry.pendingTotal()).toBeLessThanOrEqual(MAX_PENDING);
  });

  it("treats unknown sessions and duplicate responses as controlled states", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (sessionId, id) => {
        const registry = new RelayRegistry({ maxSessions: 2, responseTtlMs: 60_000 });
        expect(registry.state(sessionId).registered).toBe(false);
        expect(registry.request(sessionId, id, "e30=")).toBe("not_registered");
        expect(registry.response(sessionId, id, "e30=")).toBe("unknown");
        expect(registry.error(sessionId, id, "code", "message")).toBe("unknown");
        expect(registry.precheck(sessionId, "token")).toBe("not_found");
      }),
      { numRuns: 100, ...fuzzSeed },
    );
  });
});

describe("relay HTTP", () => {
  let relay: RelayServer;
  let base: string;
  let port: number;

  beforeAll(async () => {
    relay = createRelay({ adminToken: ADMIN, responseTtlMs: 30_000 });
    await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
    port = (relay.server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
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

  it("never returns 500 for arbitrary register and request bodies", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (body) => {
        const registered = await admin("/internal/register", {
          method: "POST",
          body: JSON.stringify(body),
        });
        expect(registered.status).toBeLessThan(500);

        const forwarded = await admin("/internal/sbx_relay_http_fuzz/request", {
          method: "POST",
          body: JSON.stringify(body),
        });
        expect(forwarded.status).toBeLessThan(500);
      }),
      { numRuns: 80, ...fuzzSeed },
    );
  });

  it("rejects an envelope above the 24 MiB frame cap", async () => {
    const oversized = "A".repeat(MAX_FRAME_BYTES + 1);
    const res = await admin("/internal/sbx_relay_http_fuzz/request", {
      method: "POST",
      body: JSON.stringify({ id: "request-oversized", envelope: oversized }),
    });
    expect(res.status).toBe(400);
  });

  it("answers 400 for malformed JSON", async () => {
    for (const raw of ["", "{", "not json", "[1,2,3]", "null"]) {
      const res = await admin("/internal/register", { method: "POST", body: raw });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });

  it("stays healthy after malformed WebSocket frames", async () => {
    const frames = [
      "",
      "not json",
      "null",
      "[]",
      "{}",
      JSON.stringify({ type: 42 }),
      JSON.stringify({ type: "unknown" }),
      JSON.stringify({ type: "response", id: 1, envelope: {} }),
      JSON.stringify({ type: "response", id: "request-1", envelope: "x".repeat(256) }),
      JSON.stringify({ type: "error", id: null, code: null, message: null }),
      JSON.stringify({ type: "hello", evidence: null }),
      JSON.stringify({ type: "hello", evidence: "string" }),
      "x".repeat(512),
    ];

    for (const [index, frame] of frames.entries()) {
      const sessionId = `sbx_relay_ws_fuzz_${index}`;
      expect(
        (await admin("/internal/register", {
          method: "POST",
          body: JSON.stringify({ sessionId, tokenHash: sha256Hex(TOKEN), ttlMs: 30_000 }),
        })).status,
      ).toBe(201);

      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/guest?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(TOKEN)}`,
      );
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      // Hello is required before the relay accepts anything else; send a
      // valid one only for the frames that must reach the message switch.
      ws.send(
        JSON.stringify({
          type: "hello",
          evidence: { sessionId, evidenceType: "dev-simulated", insecureDevOnly: true },
        }),
      );
      await sleep(20);
      ws.send(frame);
      await sleep(50);
      ws.terminate();

      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      const purge = await admin(`/internal/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      expect([200, 404]).toContain(purge.status);
    }
  });

  it("closes a binary frame instead of parsing it", async () => {
    const sessionId = "sbx_relay_ws_binary";
    expect(
      (await admin("/internal/register", {
        method: "POST",
        body: JSON.stringify({ sessionId, tokenHash: sha256Hex(TOKEN), ttlMs: 30_000 }),
      })).status,
    ).toBe(201);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/guest?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(TOKEN)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code));
    });
    ws.send(Buffer.from([0, 1, 2, 3]));
    expect(await closed).toBe(1009);
    await admin(`/internal/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  });
});
