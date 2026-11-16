/**
 * Property tests against the real operations router.
 *
 * The goal is the HTTP contract, not the guest: whatever JSON arrives at
 * `POST /v1/sessions/:id/operations`, the route must answer with a controlled
 * 4xx (or a successful forward), never a 500 and never an unhandled rejection.
 * The controller is stubbed so no cluster is involved.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fuzzSeed } from "./seeds.js";
import { sha256Hex } from "@x402s/shared/crypto";
import { createSessionsRouter } from "../../api/src/routes/sessions.js";
import { errorBackstop } from "../../api/src/routes/errors.js";
import type { ApiConfig } from "../../api/src/config.js";
import type { ControllerClient, SessionView } from "../../api/src/controller-client.js";

const SESSION_ID = "sbx_fuzz_session";
const CAPABILITY = "c".repeat(32);

const config = {
  readRateBurst: 1_000_000,
  readRateRefill: 1_000_000,
  platformLimits: { maxCommandSeconds: 30 },
} as unknown as ApiConfig;

const session = {
  sessionId: SESSION_ID,
  state: "READY",
  capabilityHash: sha256Hex(CAPABILITY),
  capabilityExpiresAt: Date.now() + 3_600_000,
  clientNonce: "n".repeat(44),
  clientPublicKey: "p".repeat(44),
  tier: "standard",
  durationSeconds: 300,
  limits: {},
  createdAt: Date.now(),
  remainingSeconds: 300,
  busy: false,
  payment: {},
} as unknown as SessionView;

const controller = {
  async getSession(id: string): Promise<SessionView> {
    return { ...session, sessionId: id };
  },
  async operation(
    _sessionId: string,
    req: { requestId: string },
  ): Promise<{ state: string; requestId: string; envelope: string; pending?: boolean }> {
    return { state: "READY", requestId: req.requestId, envelope: "e30=" };
  },
  async getOperation(
    _sessionId: string,
    requestId: string,
  ): Promise<{ state: string; requestId: string; envelope: string }> {
    return { state: "READY", requestId, envelope: "e30=" };
  },
  async cancelOperation(): Promise<void> {},
} as unknown as ControllerClient;

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "32mb" }));
  app.use(createSessionsRouter({ config, controller }));
  // The real backstop `api/src/server.ts` puts after the router: without it a
  // refused body would answer with Express's HTML page and "always JSON" would
  // be untestable.
  app.use(errorBackstop);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The shared GET/POST answer shape, so an assertion can name the body it wants. */
interface Answer {
  status: number;
  json: boolean;
  body: Record<string, unknown> | undefined;
}

async function answer(res: Response): Promise<Answer> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  const contentType = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    json: contentType.includes("application/json"),
    body: parsed as Record<string, unknown> | undefined,
  };
}

async function post(body: unknown): Promise<Answer> {
  return answer(
    await fetch(`${base}/v1/sessions/${SESSION_ID}/operations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sandbox-capability": CAPABILITY,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("operations route", () => {
  it("never returns 500 for arbitrary JSON bodies", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (body) => {
        const res = await post(body);
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(500);
        // express.json({strict: true}) rejects top-level primitives before the
        // router, so those answers are not guaranteed to be JSON.
        if (body !== null && typeof body === "object") {
          expect(res.json).toBe(true);
        }
      }),
      { numRuns: 120, ...fuzzSeed },
    );
  });

  it("answers 400 for malformed JSON instead of failing the request", async () => {
    /**
     * Body -> which layer refuses it. The parser takes an object or an array and
     * refuses anything else (`null`, or text that does not parse), so a top-level
     * array is the schema's refusal and `null` is the parser's. An empty body
     * parses as `{}`, which is also the schema's.
     */
    const cases: Array<[string, string]> = [
      ["{", "invalid_json"],
      ['{"requestId":', "invalid_json"],
      ["not json", "invalid_json"],
      ["null", "invalid_json"],
      ["[1,2,3]", "invalid_request"],
      ["", "invalid_request"],
    ];
    for (const [raw, error] of cases) {
      const res = await answer(
        await fetch(`${base}/v1/sessions/${SESSION_ID}/operations`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sandbox-capability": CAPABILITY,
          },
          body: raw,
        }),
      );
      expect(res.status, raw).toBe(400);
      expect(res.body, raw).toMatchObject({ error });
    }
  });

  it("rejects plaintext fields with 400 before schema validation", async () => {
    const res = await post({
      requestId: "request-1234",
      envelope: "AAAA",
      command: ["sh", "-c", "id"],
    });
    expect(res.status).toBe(400);
    // The guard names the field it refused; a generic 400 would leave a client
    // guessing which of its keys was the plaintext one.
    expect(res.body).toEqual({
      error: "plaintext_not_accepted",
      message: "this endpoint only accepts ciphertext; encrypt your operation for the attested guest key",
      field: "command",
    });
  });

  it("forwards a valid operation and refuses a bad request id with its issues", async () => {
    const ok = await post({ requestId: "request-1234", envelope: "AAAA" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ state: "READY", requestId: "request-1234", envelope: "e30=" });
    const bad = await post({ requestId: "x", envelope: "AAAA" });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: "invalid_request" });
    expect(Array.isArray(bad.body?.issues)).toBe(true);
  });

  it("rejects arbitrary query envelopes on GET without a 5xx", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 64 }), fc.string({ maxLength: 64 }), async (request, requestId) => {
        const url = new URL(`${base}/v1/sessions/${SESSION_ID}/operations`);
        url.searchParams.set("request", request);
        url.searchParams.set("requestId", requestId);
        const res = await fetch(url, { headers: { "x-sandbox-capability": CAPABILITY } });
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(500);
      }),
      { numRuns: 80, ...fuzzSeed },
    );
  });

  it("requires a capability before parsing the body", async () => {
    const res = await fetch(`${base}/v1/sessions/${SESSION_ID}/operations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "request-1234", envelope: "AAAA" }),
    });
    expect(res.status).toBe(401);
  });
});
