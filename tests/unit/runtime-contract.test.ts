/**
 * Runtime profile contract: the shared list, spec resolution and the create
 * route's rejection order. An unknown runtime must be a 400 before any
 * capacity check, payment requirement or 402.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME,
  SUPPORTED_RUNTIMES,
  resolveRuntime,
} from "../../shared/src/entries/runtimes.js";
import {
  DEFAULT_TIERS,
  loadPlatformLimits,
  resolveSessionSpec,
  specHash,
} from "../../shared/src/entries/payment.js";
import { TokenBucket } from "../../shared/src/entries/runtime.js";
import { createSessionHandler } from "../../api/src/routes/create-session.js";

const limits = loadPlatformLimits({});
const keys = { clientPublicKey: "a".repeat(44), clientNonce: "b".repeat(44) };

function resolve(extra: Record<string, unknown> = {}) {
  return resolveSessionSpec({ tier: "standard", ...keys, ...extra } as never, DEFAULT_TIERS, limits);
}

async function post(body: unknown) {
  const requirementFor = vi.fn(async () => ({
    scheme: "exact",
    network: "mock:local",
    asset: "mock:usdc",
    amount: "50000",
    payTo: "0x0000000000000000000000000000000000000402",
    maxTimeoutSeconds: 300,
    extra: {},
  }));
  const payment402 = vi.fn(async (res, _requirement, error: string) => {
    res.status(402).json({ error });
  });
  const preflightCapacity = vi.fn(async () => ({ admitted: true as const, reservationId: "r" }));
  const headers: Record<string, string> = {};
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    on(_event: string, _handler: () => void) {
      return this;
    },
  };
  const request = {
    body,
    ip: "127.0.0.1",
    header: () => undefined,
    on: () => undefined,
  };
  const handler = createSessionHandler({
    config: {
      tiers: DEFAULT_TIERS,
      platformLimits: limits,
      network: "mock:local",
      paymentMode: "mock",
      capabilityTtlSeconds: 60,
      intentStaleMs: 30_000,
    },
    controller: { preflightCapacity },
    resourceServer: {},
    settlementLookup: {},
    requirementFor,
    payment402,
    capabilityFor: () => "capability",
    ipCreateLimiter: new TokenBucket(100, 100),
    createLimiter: new TokenBucket(100, 100),
  } as never);
  await handler(request as never, response as never);
  return {
    status: response.statusCode,
    body: response.body as { error?: string },
    requirementFor,
    payment402,
    preflightCapacity,
  };
}

describe("runtime contract", () => {
  it("publishes the supported profiles with base as the default", () => {
    expect(SUPPORTED_RUNTIMES).toEqual(["base", "python", "node"]);
    expect(DEFAULT_RUNTIME).toBe("base");
    expect(resolveRuntime(undefined)).toEqual({ ok: true, runtime: "base" });
    expect(resolveRuntime("python")).toEqual({ ok: true, runtime: "python" });
    expect(resolveRuntime("cobol")).toMatchObject({ ok: false, code: "unsupported_runtime" });
  });

  it("puts the resolved runtime in the immutable spec", () => {
    const base = resolve();
    expect(base.ok).toBe(true);
    if (base.ok) {
      expect(base.spec.runtime).toBe("base");
      expect(base.priceUsd).toBe("$0.05");
    }

    const python = resolve({ runtime: "python" });
    expect(python.ok).toBe(true);
    if (python.ok) expect(python.spec.runtime).toBe("python");

    const node = resolve({ runtime: "node" });
    expect(node.ok).toBe(true);
    if (node.ok) expect(node.spec.runtime).toBe("node");
  });

  it("rejects an unknown runtime before pricing", () => {
    const unknown = resolve({ runtime: "cobol" });
    expect(unknown).toEqual({
      ok: false,
      code: "unsupported_runtime",
      message: expect.stringContaining("base, python, node"),
    });
  });

  it("includes the runtime in the spec hash", () => {
    const base = resolve();
    const python = resolve({ runtime: "python" });
    const explicitBase = resolve({ runtime: "base" });
    if (!base.ok || !python.ok || !explicitBase.ok) throw new Error("expected resolvable specs");
    expect(specHash(base.spec)).toMatch(/^[0-9a-f]{64}$/);
    expect(specHash(base.spec)).toBe(specHash(explicitBase.spec));
    expect(specHash(python.spec)).not.toBe(specHash(base.spec));
  });

  it("returns 400 unsupported_runtime before any payment or capacity work", async () => {
    const result = await post({ tier: "standard", runtime: "cobol", ...keys });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("unsupported_runtime");
    expect(result.requirementFor).not.toHaveBeenCalled();
    expect(result.payment402).not.toHaveBeenCalled();
    expect(result.preflightCapacity).not.toHaveBeenCalled();
  });

  it("lets a supported runtime through to the 402 challenge", async () => {
    const result = await post({ tier: "standard", runtime: "python", ...keys });
    expect(result.status).toBe(402);
    expect(result.requirementFor).toHaveBeenCalledTimes(1);
    expect(result.preflightCapacity).toHaveBeenCalledTimes(1);
  });
});
