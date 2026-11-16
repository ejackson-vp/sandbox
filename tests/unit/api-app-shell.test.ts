/**
 * The app shell: the routes that are not the session API, and the error backstop.
 *
 * These are cheap endpoints with expensive failure modes. `/readyz` must not
 * forward the controller's component detail to the ingress, a 402 must not be
 * issued without a fresh challenge nonce (a client cannot sign one that does not
 * exist), and a body the parser refuses must be attributed to the client (400 or
 * 413), never answered as a 500.
 *
 * The integration suite drives the same app end to end over the real controller;
 * what it cannot cheaply pin are the refusals, which is what this file is for.
 * The resource server and controller are injected, which `createApp` already
 * offers.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { loadConfig } from "../../api/src/config.js";
import { ControllerError } from "../../api/src/controller-client.js";
import { errorBackstop } from "../../api/src/routes/errors.js";
import { createApp } from "../../api/src/server.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function config(env: Record<string, string> = {}) {
  return loadConfig({
    PAYMENT_MODE: "mock",
    ALLOW_INSECURE_DEV: "true",
    CONTROLLER_ADMIN_TOKEN: "a".repeat(32),
    CAPABILITY_SECRET: "s".repeat(32),
    ...env,
  });
}

const REQUIREMENT = {
  scheme: "exact",
  network: "mock:local",
  asset: "mock:usdc",
  amount: "50000",
  payTo: "0x0000000000000000000000000000000000000402",
  maxTimeoutSeconds: 300,
  extra: { tier: "standard", durationSeconds: 300 },
};

async function app(
  opts: {
    env?: Record<string, string>;
    controller?: Record<string, unknown>;
    resourceServer?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const controller = {
    readiness: async () => ({ ok: true }),
    issueChallengeNonce: async () => ({ nonce: `cn_${"a".repeat(32)}`, expiresAt: Date.now() + 60_000 }),
    preflightCapacity: async () => ({ admitted: true, nodeId: "node-a", reservation: { nodeId: "node-a" } }),
    /**
     * The create kill switch, off. Without this the create use case fails closed
     * on an unreachable switch, and every 402 case here would be refused before
     * the challenge it is written to exercise.
     */
    readCreateSwitch: async () => ({
      enabled: false,
      reason: "",
      actor: "",
      changedAt: null,
      expiresAt: null,
      expired: false,
    }),
    getSession: async () => {
      throw new ControllerError(404, "session_not_found", "no such session");
    },
    ...opts.controller,
  };
  const resourceServer = {
    initialize: async () => undefined,
    register: () => undefined,
    buildPaymentRequirements: async () => [REQUIREMENT],
    createPaymentRequiredResponse: async () => ({ x402Version: 2, accepts: [REQUIREMENT] }),
    ...opts.resourceServer,
  };
  const expressApp = await createApp({
    config: config(opts.env),
    controller,
    settlementLookup: { supported: false, lookup: async () => null },
    resourceServer,
  } as never);
  const server = await new Promise<Server>((resolve) => {
    const listener = expressApp.listen(0, "127.0.0.1", () => resolve(listener));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const createBody = { tier: "standard", clientPublicKey: "a".repeat(44), clientNonce: "b".repeat(44) };

describe("health and readiness", () => {
  it("reports the payment mode and network on /healthz", async () => {
    const base = await app();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, paymentMode: "mock", network: "mock:local" });
  });

  it("answers 200 on /readyz when the controller is ready", async () => {
    const base = await app();
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("answers 503 without forwarding the controller's component detail", async () => {
    const base = await app({
      controller: {
        readiness: async () => ({
          ok: false,
          components: { store: { ok: false, reason: "no route to 10.0.0.7" } },
        }),
      },
    });
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    // The API classifies the answer itself; the controller's own component
    // detail stays cluster-internal.
    expect(body).toMatchObject({ ok: false, components: { controller: { ok: false, reason: "not_ready" } } });
    expect(JSON.stringify(body)).not.toContain("10.0.0.7");
  });

  it("reports an unreachable controller as unreachable, not as ready", async () => {
    const base = await app({
      controller: {
        readiness: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      },
    });
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      ok: false,
      components: { controller: { ok: false, reason: "unreachable" } },
    });
  });
});

describe("catalogue", () => {
  it("publishes the configured tiers and platform limits", async () => {
    const base = await app();
    const body = (await (await fetch(`${base}/v1/pricing`)).json()) as {
      paymentMode: string;
      asset: string;
      tiers: Record<string, { priceUsd: string; durationSeconds: number }>;
    };
    expect(body.paymentMode).toBe("mock");
    expect(body.asset).toBe("mock:usdc");
    expect(Object.keys(body.tiers).length).toBeGreaterThan(0);
    expect(body.tiers.standard).toMatchObject({ priceUsd: expect.any(String), durationSeconds: 300 });
  });

  it("reports the guest image from the environment, with dev defaults", async () => {
    const base = await app();
    const body = (await (await fetch(`${base}/v1/images`)).json()) as {
      images: Array<{ id: string; digest: string; current: boolean }>;
    };
    expect(body.images).toHaveLength(1);
    expect(body.images[0]).toMatchObject({ id: "guest", current: true });
    expect(body.images[0]!.digest).toMatch(/^sha256:/);
  });
});

describe("the 402 challenge", () => {
  it("issues a fresh challenge nonce with the payment requirements", async () => {
    const base = await app();
    const res = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBeTruthy();
    const body = (await res.json()) as { error: string; challengeNonce: string };
    expect(body.error).toBe("payment_required");
    expect(body.challengeNonce).toMatch(/^cn_/);
  });

  it("refuses to issue a challenge rather than answer 402 without a nonce", async () => {
    const base = await app({
      controller: {
        issueChallengeNonce: async () => {
          throw new ControllerError(503, "control_plane_unavailable", "no answer");
        },
      },
    });
    const res = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(await res.json()).toMatchObject({ error: "challenge_unavailable", retryable: true });
  });

  /**
   * The app-shell level order: with the switch on, a well-formed create is
   * refused before the challenge is minted. A nonce issued for a payment that
   * can never be used is exactly what the kill switch exists to prevent, so no
   * nonce and no PAYMENT-REQUIRED header may leave this route.
   */
  it("refuses with creates_disabled and issues no nonce when the switch is on", async () => {
    const issueChallengeNonce = vi.fn(async () => ({
      nonce: `cn_${"a".repeat(32)}`,
      expiresAt: Date.now() + 60_000,
    }));
    const base = await app({
      controller: {
        issueChallengeNonce,
        readCreateSwitch: async () => ({
          enabled: true,
          reason: "payment incident INC-431",
          actor: "eric",
          changedAt: Date.now(),
          expiresAt: null,
          expired: false,
        }),
      },
    });

    const res = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("payment-required")).toBeNull();
    expect(await res.json()).toEqual({
      error: "creates_disabled",
      retryable: true,
      message: "payment incident INC-431",
    });
    expect(issueChallengeNonce).not.toHaveBeenCalled();
  });
});

describe("the body parser's refusals", () => {
  it("answers 400 invalid_json for a body that is not JSON", async () => {
    const base = await app();
    const res = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("answers 413 payload_too_large instead of 500", async () => {
    const base = await app({ env: { MAX_BODY_BYTES: "1024" } });
    const res = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...createBody, padding: "x".repeat(4_096) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });

  it("refuses a plaintext command on the create route", async () => {
    const base = await app();
    const res = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...createBody, command: ["cat", "/etc/shadow"] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "plaintext_not_accepted" });
  });
});

describe("response headers", () => {
  it("sets no-store and nosniff on every response", async () => {
    const base = await app();
    const res = await fetch(`${base}/healthz`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });
});

/**
 * The backstop's own two refusals. Every route validates with `safeParse` and
 * answers 400 itself, so these only run when a handler throws instead: the
 * answers still have to be the client's (400 with the issues) or the process's
 * (500 with no internal message), never a stack trace.
 */
describe("the error backstop", () => {
  async function throwingApp(thrower: () => never): Promise<string> {
    const expressApp = express();
    expressApp.get("/throws", () => thrower());
    expressApp.use(errorBackstop);
    const server = await new Promise<Server>((resolve) => {
      const listener = expressApp.listen(0, "127.0.0.1", () => resolve(listener));
    });
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("answers a thrown ZodError as the same 400 a safeParse refusal writes", async () => {
    const base = await throwingApp(() => {
      throw new ZodError([
        {
          code: "invalid_type",
          path: ["tier"],
          message: "Expected string, received number",
          expected: "string",
          received: "number",
        } as never,
      ]);
    });
    const res = await fetch(`${base}/throws`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_request",
      issues: [
        {
          code: "invalid_type",
          path: ["tier"],
          message: "Expected string, received number",
          expected: "string",
          received: "number",
        },
      ],
    });
  });

  it("answers any other throw as a 500 without the internal message", async () => {
    const base = await throwingApp(() => {
      throw new Error("connect ECONNREFUSED 10.0.0.7:3001");
    });
    const res = await fetch(`${base}/throws`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });
});
