/**
 * Bazaar discovery metadata: the difference between a listed resource and an
 * endpoint nobody can find.
 *
 * The CDP Bazaar indexes a resource only when its 402 carries
 * `extensions.bazaar`, and an agent can only build a call when the example in
 * that block is a body the route accepts. Both halves are pinned here, because
 * either one failing leaves the endpoint in the catalogue but unusable, which
 * is the same outcome as not being listed.
 *
 * The example is checked against the real `createSchema` rather than a copy of
 * it: the schema is the only definition of a valid body, and a stale copy in
 * this file would pass while the route rejected the example.
 */
import { describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import type { PaymentPayload } from "../../api/src/use-cases/create-session-contract.js";
import { DEFAULT_TIERS } from "../../shared/src/entries/payment.js";
import { resolveSessionSpec } from "../../shared/src/tiers.js";
import { loadPlatformLimits } from "../../shared/src/entries/payment.js";
import { createPaymentRequiredWriter, type DiscoveryEcho } from "../../api/src/payments/payment-required.js";
import { verifyAndSettle } from "../../api/src/use-cases/create-session-settlement.js";
import { sessionBazaarExtension } from "../../api/src/payments/bazaar.js";
import { createSchema } from "../../api/src/schemas.js";

const LIMITS = loadPlatformLimits({});

/** The example the Bazaar indexer replays, as an agent would read it. */
function exampleOf(extension: Record<string, unknown>): Record<string, unknown> {
  const bazaar = extension.bazaar as {
    info: { input: { body: Record<string, unknown> } };
  };
  return bazaar.info.input.body;
}

function bazaarOf(extension: Record<string, unknown>): {
  info: { input: { body: Record<string, unknown>; method: string }; output: { example: unknown } };
  schema: { required: string[]; properties: Record<string, unknown> };
} {
  return extension.bazaar as never;
}

describe("the session discovery extension", () => {
  const resolution = resolveSessionSpec(
    { tier: "short", clientPublicKey: "A".repeat(44), clientNonce: "B".repeat(44) },
    DEFAULT_TIERS,
    LIMITS,
  );
  if (!resolution.ok) throw new Error("short tier must resolve");
  const extension = sessionBazaarExtension({
    tiers: DEFAULT_TIERS,
    exampleTier: "short",
    runtime: resolution.spec.runtime,
    limits: resolution.spec.limits,
  });

  it("carries an example the create route actually accepts", () => {
    // The indexer posts this body. A schema-first route answers 400 to anything
    // that does not parse, so discovery would stop before the 402 it is looking
    // for, and the resource would never be listed.
    const parsed = createSchema.safeParse(exampleOf(extension));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.tier).toBe("short");
  });

  it("declares the input as a POST with a JSON body", () => {
    const input = bazaarOf(extension).info.input;
    expect(input.method).toBe("POST");
    expect(bazaarOf(extension).schema.required).toEqual(["input"]);
  });

  it("offers every configured tier, priced as configured", () => {
    const body = bazaarOf(extension).schema.properties.input as {
      properties: { body: { properties: { tier: { enum: string[]; description: string } } } };
    };
    const tier = body.properties.body.properties.tier;
    expect(tier.enum).toEqual(Object.keys(DEFAULT_TIERS));
    // The price an agent reads is the price it is charged: both come from the
    // same table, so a configured price change cannot leave the copy behind.
    for (const definition of Object.values(DEFAULT_TIERS)) {
      expect(tier.description).toContain(definition.priceUsd);
      expect(tier.description).toContain(`${definition.durationSeconds} seconds`);
    }
  });

  it("describes the settled body an agent gets back", () => {
    const example = bazaarOf(extension).info.output.example as Record<string, unknown>;
    expect(example).toMatchObject({ state: "PAID", tier: "short", durationSeconds: 60 });
    expect(example.limits).toEqual(resolution.spec.limits);
  });

  it("refuses to build for a tier the deployment does not sell", () => {
    expect(() =>
      sessionBazaarExtension({
        tiers: DEFAULT_TIERS,
        exampleTier: "enormous",
        runtime: resolution.spec.runtime,
        limits: resolution.spec.limits,
      }),
    ).toThrow(/enormous/);
  });
});

describe("the settled call", () => {
  const EXTENSIONS = { bazaar: { info: {}, schema: {} } };
  const RESOURCE = {
    url: "https://sandbox.test/v1/sessions",
    description: "one disposable linux machine",
    mimeType: "application/json",
    serviceName: "throwbox",
  };
  const PAYLOAD = {
    x402Version: 2,
    resource: RESOURCE,
    accepted: {},
    payload: { authorization: { from: "0x0000000000000000000000000000000000000402" } },
  } as unknown as PaymentPayload;
  const REQUIREMENT = { amount: "20000" } as PaymentRequirements;

  function deps(discovery?: DiscoveryEcho) {
    return {
      resourceServer: {
        verifyPayment: async () => ({ isValid: true }),
        settlePayment: vi.fn(async (..._args: unknown[]) => ({
          success: true,
          transaction: "0xtx",
          network: "eip155:8453",
        })),
      },
      controller: { healthz: async () => ({ ok: true }), failIntent: async () => undefined },
      ...(discovery ? { discovery } : {}),
    };
  }

  it("echoes the resource and the extension to the facilitator", async () => {
    const d = deps({ resource: RESOURCE, extensions: EXTENSIONS });
    const result = await verifyAndSettle(d as never, PAYLOAD, REQUIREMENT, "key", {
      verifyMs: 0,
      settleMs: 0,
    });

    expect(result.ok).toBe(true);
    const settled = d.resourceServer.settlePayment.mock.calls[0]?.[0] as unknown as {
      resource?: unknown;
      extensions?: unknown;
      payload?: unknown;
    };
    // The Bazaar indexes from the settlement call, so both fields have to be on
    // the payload the facilitator is asked to settle.
    expect(settled.resource).toEqual(RESOURCE);
    expect(settled.extensions).toEqual(EXTENSIONS);
    // The envelope is extended; the authorization the signature covers is not.
    expect(settled.payload).toEqual(PAYLOAD.payload);
  });

  it("sends the payload as signed when discovery is off", async () => {
    const d = deps();
    await verifyAndSettle(d as never, PAYLOAD, REQUIREMENT, "key", { verifyMs: 0, settleMs: 0 });

    const settled = d.resourceServer.settlePayment.mock.calls[0]?.[0] as unknown as {
      extensions?: unknown;
    };
    expect(settled.extensions).toBeUndefined();
  });
});

describe("the 402 that carries it", () => {
  const requirement = {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount: "20000",
    payTo: "0x0000000000000000000000000000000000000402",
    maxTimeoutSeconds: 300,
    extra: {},
  } as PaymentRequirements;

  function writer(extensions?: Record<string, unknown>) {
    const createPaymentRequiredResponse = vi.fn(
      async (_accepts: unknown, _info: unknown, error: string, ext?: Record<string, unknown>) => ({
        x402Version: 2,
        error,
        resource: { url: "https://sandbox.test/v1/sessions" },
        accepts: [requirement],
        ...(ext ? { extensions: ext } : {}),
      }),
    );
    const write = createPaymentRequiredWriter({
      controller: {
        issueChallengeNonce: async () => ({ nonce: `cn_${"a".repeat(32)}`, expiresAt: Date.now() + 60_000 }),
      },
      resourceServer: { createPaymentRequiredResponse },
      resourceInfo: {
        url: "https://sandbox.test/v1/sessions",
        description: "test",
        mimeType: "application/json",
        serviceName: "test",
      },
      ...(extensions ? { extensions } : {}),
    });
    return { write, createPaymentRequiredResponse };
  }

  function response() {
    const captured = {
      statusCode: 0,
      headers: new Map<string, string>(),
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader(name: string, value: string) {
        this.headers.set(name.toLowerCase(), value);
        return this;
      },
      json(value: unknown) {
        this.body = value;
        return this;
      },
    };
    return captured;
  }

  it("passes the extension through to the encoded challenge", async () => {
    const extension = { bazaar: { info: {}, schema: {} } };
    const { write } = writer(extension);
    const res = response();
    await write(res as never, requirement, "payment_required");

    expect(res.statusCode).toBe(402);
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    // The header is what a client and the facilitator read, so the extension
    // has to survive the encoding, not only the JSON body.
    const decoded = decodePaymentRequiredHeader(header as string) as { extensions?: unknown };
    expect(decoded.extensions).toEqual(extension);
    // Round-tripping through the encoder keeps this test honest about the wire.
    expect(decodePaymentRequiredHeader(encodePaymentRequiredHeader(decoded as never))).toEqual(decoded);
  });

  it("keeps the challenge clean when discovery is off", async () => {
    const { write, createPaymentRequiredResponse } = writer();
    const res = response();
    await write(res as never, requirement, "payment_required");

    expect(createPaymentRequiredResponse).toHaveBeenCalledWith(
      [expect.objectContaining({ amount: "20000" })],
      expect.anything(),
      "payment_required",
      undefined,
    );
    expect((res.body as { extensions?: unknown }).extensions).toBeUndefined();
  });
});
