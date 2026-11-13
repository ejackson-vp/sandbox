/**
 * Property tests against the real create-session route.
 *
 * `POST /v1/sessions` is the only public write path. It prices a request before
 * anything else, refuses plaintext before the schema sees it, and hands the rest
 * to the x402 use case. The contract pinned here is that no body can move the
 * price it is quoted or reach a 5xx: a request gets the tier's own amount back
 * in a 402, a 400 naming why it was refused, a 429 from the IP bucket, or the
 * capacity answer with its retry hint. Arbitrary JSON, arbitrary field names and
 * arbitrary payment headers are all answered rather than thrown.
 *
 * The outbound controller and the facilitator are stubbed, so no cluster and no
 * payment are involved. The router, the body parser and the plaintext guard are
 * the real ones.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { fuzzSeed } from "./seeds.js";
import {
  DEFAULT_TIERS,
  loadPlatformLimits,
  MOCK_NETWORK,
  type PlatformLimits,
} from "@x402s/shared/payment";
import { parseUsdPrice } from "@x402s/shared/money";
import { TokenBucket } from "@x402s/shared/runtime";
import { createSessionHandler } from "../../api/src/routes/create-session.js";
import { createSchema, rejectPlaintextBodies } from "../../api/src/schemas.js";
import type { RateLimiter } from "../../api/src/admission.js";
import type { ApiConfig } from "../../api/src/config.js";
import type { ControllerClient } from "../../api/src/controller-client.js";

const CLIENT_KEY = "p".repeat(44);
const CLIENT_NONCE = "n".repeat(44);

const platformLimits = loadPlatformLimits({});
const standard = DEFAULT_TIERS.standard;
const STANDARD_AMOUNT = parseUsdPrice(standard.priceUsd).amount.toString();

/** The fields `createSchema` defines; everything else must be ignored. */
const SCHEMA_FIELDS = new Set(Object.keys(createSchema.shape));

/** The plaintext guard's list, restated so a change to it fails here. */
const FORBIDDEN_FIELDS = [
  "code",
  "source",
  "script",
  "command",
  "args",
  "argv",
  "env",
  "cwd",
  "stdin",
  "stdout",
  "stderr",
  "content",
  "data",
  "plaintext",
] as const;

const controller = {
  async preflightCapacity() {
    return { admitted: true as const, nodeId: "node-fuzz", reservation: { nodeId: "node-fuzz" } };
  },
} as unknown as ControllerClient;

/** Capacity that refuses, which is the only way an unpaid quote carries headers. */
const refusingController = {
  async preflightCapacity() {
    return {
      admitted: false as const,
      reason: "no_nodes",
      retryable: true,
      requested: { cpuMillicores: 500, memoryBytes: 1, storageBytes: 1 },
    };
  },
} as unknown as ControllerClient;

interface Answer {
  status: number;
  json: boolean;
  body: Record<string, unknown> | undefined;
  headers: Headers;
}

const servers: Server[] = [];

/**
 * Mount the production middleware order: body parser, plaintext guard, handler,
 * and the same backstop `api/src/server.ts` puts after it. Without the backstop
 * a thrown handler would answer 500 with an HTML body, so "never 5xx" would be
 * unfalsifiable.
 */
function startApp(
  options: {
    ipLimiter?: RateLimiter;
    outbound?: ControllerClient;
    limits?: PlatformLimits;
  } = {},
): Promise<string> {
  const ipLimiter = options.ipLimiter ?? new TokenBucket(1_000_000, 1_000_000);
  const app = express();
  app.use(express.json({ limit: "32mb" }));
  app.post(
    "/v1/sessions",
    rejectPlaintextBodies,
    createSessionHandler({
      config: {
        tiers: DEFAULT_TIERS,
        platformLimits: options.limits ?? platformLimits,
        network: MOCK_NETWORK,
        paymentMode: "mock",
        capabilityTtlSeconds: 60,
        intentStaleMs: 30_000,
      } as unknown as ApiConfig,
      controller: options.outbound ?? controller,
      resourceServer: {} as never,
      settlementLookup: { supported: false, lookup: async () => null },
      requirementFor: async (priceUsd, spec) => ({
        scheme: "exact",
        network: MOCK_NETWORK,
        asset: "mock:usdc",
        amount: parseUsdPrice(priceUsd).amount.toString(),
        payTo: "0x0000000000000000000000000000000000000402",
        maxTimeoutSeconds: 300,
        extra: { tier: spec.tier, durationSeconds: spec.durationSeconds },
      }),
      // The real encoder issues a challenge nonce first. The amount is what
      // this file is about, so echo it and keep the rest inert.
      payment402: async (res, requirement, error) => {
        res.status(402).json({ error, amount: requirement.amount });
      },
      capabilityFor: () => "capability",
      recoverCapability: () => null,
      createLimiter: new TokenBucket(1_000_000, 1_000_000),
      ipCreateLimiter: ipLimiter,
    }),
  );
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "invalid_request", issues: err.issues });
      return;
    }
    if ((err as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: "payload_too_large" });
      return;
    }
    if (err.name === "SyntaxError") {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    res.status(500).json({ error: "internal_error" });
  });
  const server = http.createServer(app);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

let base: string;

beforeAll(async () => {
  base = await startApp();
});

afterAll(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function post(
  body: unknown,
  extraHeaders: Record<string, string> = {},
  target = base,
): Promise<Answer> {
  const res = await fetch(`${target}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return {
    status: res.status,
    json: (res.headers.get("content-type") ?? "").includes("application/json"),
    body: parsed as Record<string, unknown> | undefined,
    headers: res.headers,
  };
}

/** A body the schema accepts, so the only variable is what the test adds. */
function validBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra, tier: "standard", clientPublicKey: CLIENT_KEY, clientNonce: CLIENT_NONCE };
}

describe("create-session route", () => {
  it("answers arbitrary JSON with a controlled 4xx, never a 5xx", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (body) => {
        const res = await post(body);
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(500);
        // express.json({strict: true}) rejects top-level primitives before the
        // router, and the backstop writes that refusal as JSON too.
        if (body !== null && typeof body === "object") {
          expect(res.json).toBe(true);
        }
      }),
      { numRuns: 120, ...fuzzSeed },
    );
  });

  it("refuses plaintext before schema validation, whatever else the body says", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...FORBIDDEN_FIELDS),
        fc.jsonValue(),
        async (field, value) => {
          // No client key and no tier: schema-first would answer invalid_request,
          // so a plaintext answer proves the guard runs first.
          const res = await post({ [field]: value });
          expect(res.status).toBe(400);
          expect(res.body).toMatchObject({ error: "plaintext_not_accepted", field });
        },
      ),
      { numRuns: 60, ...fuzzSeed },
    );
  });

  it("quotes the tier price whatever extra fields the body carries", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 16 }), fc.jsonValue()), {
          maxLength: 8,
        }),
        async (pairs) => {
          const res = await post(validBody(Object.fromEntries(pairs)));
          if (res.status === 402) {
            expect(res.body).toMatchObject({ error: "payment_required", amount: STANDARD_AMOUNT });
            return;
          }
          // A random value for a defined field is a client error, never a price
          // change and never a server failure.
          expect(res.status).toBeGreaterThanOrEqual(400);
          expect(res.status).toBeLessThan(500);
          expect(res.json).toBe(true);
        },
      ),
      { numRuns: 100, ...fuzzSeed },
    );
  });

  it("ignores fields the schema does not define", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 24 }),
        fc.jsonValue(),
        async (name, value) => {
          fc.pre(!SCHEMA_FIELDS.has(name) && !(FORBIDDEN_FIELDS as readonly string[]).includes(name));
          const res = await post(validBody({ [name]: value }));
          // An unknown field is stripped, so the request is still a valid quote
          // for the tier and costs exactly what the tier costs.
          expect(res.status).toBe(402);
          expect(res.json).toBe(true);
          expect(res.body).toMatchObject({ amount: STANDARD_AMOUNT });
        },
      ),
      { numRuns: 80, ...fuzzSeed },
    );
  });

  it("answers any payment header with a client error, never a forward", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 2_048 }), async (header) => {
        const res = await post(validBody(), { "PAYMENT-SIGNATURE": header });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(res.json).toBe(true);
      }),
      { numRuns: 100, ...fuzzSeed },
    );
  });

  it("answers malformed JSON with a 4xx instead of failing the request", async () => {
    for (const raw of ["", "{", '{"clientPublicKey":', "not json", "[1,2,3]", "null"]) {
      const res = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect((res.headers.get("content-type") ?? "").includes("application/json")).toBe(true);
    }
  });

  it("rate-limits at the IP bucket before parsing, with a retry hint", async () => {
    const refusing = { take: () => false, retryAfterSeconds: () => 7 } as unknown as RateLimiter;
    const limited = await startApp({ ipLimiter: refusing });
    const res = await post(validBody(), {}, limited);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    // The 429 is written before the schema check, so even a body the schema
    // would refuse gets the same answer: the bucket is the first decision, not
    // the last. (The plaintext guard is mounted ahead of the handler, so a
    // plaintext body is refused before either.)
    const nonsense = await post({ tier: 42 }, {}, limited);
    expect(nonsense.status).toBe(429);
  });

  it("quotes no price when capacity refuses, and keeps the retry hint", async () => {
    const url = await startApp({ outbound: refusingController });
    const res = await post(validBody(), {}, url);
    expect(res.status).toBe(503);
    expect(res.json).toBe(true);
    expect(res.body).toMatchObject({ error: "capacity_unavailable", retryable: true });
    // `rejectCapacity` sets Retry-After, which is the response writer's header
    // branch: an unpaid request is still told when to come back.
    expect(res.headers.get("retry-after")).toBe("5");
  });

  it("reports a policy refusal as a JSON 400 from the use case", async () => {
    // `custom` is disabled on this config, so the body parses and the use case
    // answers: this is the non-402 branch of the response writer.
    const url = await startApp({ limits: { ...platformLimits, allowCustom: false } });
    const res = await post(
      {
        tier: "custom",
        durationSeconds: 60,
        clientPublicKey: CLIENT_KEY,
        clientNonce: CLIENT_NONCE,
      },
      {},
      url,
    );
    expect(res.status).toBe(400);
    expect(res.json).toBe(true);
    expect(res.body).toMatchObject({ error: "custom_not_allowed" });
  });
});
