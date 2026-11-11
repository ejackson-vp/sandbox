/**
 * Session authorisation across a capability key rotation (#61).
 *
 * The ring helpers are unit-tested in `capability-rotation.test.ts`. This file
 * pins the wiring that makes rotation safe: a capability issued before the
 * rotation keeps working while the previous key is configured, and is refused
 * once it is retired. It runs the real router over a real listener with the
 * controller stubbed, so a regression in the route (not just the helper) fails.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { capabilityMac, mintCapability } from "../../shared/src/entries/crypto.js";
import { sha256Hex } from "../../shared/src/crypto.js";
import { loadConfig } from "../../api/src/config.js";
import { createSessionsRouter } from "../../api/src/routes/sessions.js";

const SESSION_ID = "sbx_0123456789abcdef";
const OLD_SECRET = "o".repeat(32);
const NEW_SECRET = "n".repeat(32);
const PAYMENT_KEY = "0x" + "a".repeat(64);
const COMMITMENT = `${"c".repeat(43)}:${"d".repeat(43)}`;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** The token a session issued before the rotation holds. */
const OLD_TOKEN = mintCapability({ id: "k1", secret: OLD_SECRET }, PAYMENT_KEY, COMMITMENT);
/** The bare form from before the key id existed. */
const LEGACY_TOKEN = capabilityMac(OLD_SECRET, PAYMENT_KEY, COMMITMENT);

async function listen(env: Record<string, string>, issuedToken: string): Promise<string> {
  const config = loadConfig({
    PAYMENT_MODE: "mock",
    ALLOW_INSECURE_DEV: "true",
    CONTROLLER_ADMIN_TOKEN: "a".repeat(32),
    CAPABILITY_SECRET: NEW_SECRET,
    ...env,
  });
  const view = {
    sessionId: SESSION_ID,
    state: "READY",
    tier: "short",
    durationSeconds: 60,
    limits: {},
    createdAt: Date.now(),
    remainingSeconds: 60,
    clientNonce: "d".repeat(43),
    clientPublicKey: "c".repeat(43),
    capabilityHash: sha256Hex(issuedToken),
    capabilityExpiresAt: Date.now() + 60_000,
    busy: false,
    payment: {
      paymentKey: PAYMENT_KEY,
      network: "mock:local",
      scheme: "exact",
      asset: "mock:usdc",
      amount: "50000",
      payTo: "0x0000000000000000000000000000000000000402",
      mode: "mock",
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createSessionsRouter({ config, controller: { getSession: async () => view } } as never));
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function status(base: string, capability: string): Promise<number> {
  return fetch(`${base}/v1/sessions/${SESSION_ID}`, {
    headers: { "x-sandbox-capability": capability },
  }).then((res) => res.status);
}

describe("capability key rotation on the read path", () => {
  it("accepts the previous key while the overlap is configured", async () => {
    const base = await listen(
      {
        CAPABILITY_KEY_ID: "k2",
        CAPABILITY_SECRET_PREVIOUS: OLD_SECRET,
        CAPABILITY_PREVIOUS_KEY_ID: "k1",
      },
      OLD_TOKEN,
    );
    expect(await status(base, OLD_TOKEN)).toBe(200);
  });

  it("refuses the same capability once the previous key is retired", async () => {
    // The stored hash still matches, so only the key-id check can refuse this.
    const base = await listen({ CAPABILITY_KEY_ID: "k2" }, OLD_TOKEN);
    expect(await status(base, OLD_TOKEN)).toBe(404);
  });

  it("accepts a legacy token with no key id while its key is configured", async () => {
    const base = await listen({ CAPABILITY_KEY_ID: "k2", CAPABILITY_SECRET: OLD_SECRET }, LEGACY_TOKEN);
    expect(await status(base, LEGACY_TOKEN)).toBe(200);
  });

  it("refuses a token signed by a different key", async () => {
    const base = await listen(
      {
        CAPABILITY_KEY_ID: "k2",
        CAPABILITY_SECRET_PREVIOUS: OLD_SECRET,
        CAPABILITY_PREVIOUS_KEY_ID: "k1",
      },
      OLD_TOKEN,
    );
    const other = mintCapability({ id: "k1", secret: NEW_SECRET }, PAYMENT_KEY, COMMITMENT);
    expect(await status(base, other)).toBe(404);
  });
});
