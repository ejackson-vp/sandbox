/**
 * The create kill switch, on the API's create path (schema v21).
 *
 * An operator at 2am flips one durable row and new creates stop. The order is
 * the contract: the refusal lands before the price, the 402 challenge, the
 * capacity hold, the intent claim and the settlement, so a caller is neither
 * charged nor handed a challenge its payment can never be used against.
 *
 * Three behaviours are pinned here:
 *
 *  - on: `503 creates_disabled`, with the operator's reason, and not one
 *    controller or facilitator call that could move money or capacity;
 *  - off: the normal paid path, unchanged;
 *  - a switch that cannot be read: `503 admission_unavailable`, because
 *    admitting creates while the store holding the switch is unreachable is the
 *    failure this control exists to prevent.
 *
 * The live-session half is in this file too, because "creates are off" must not
 * be confused with "the service is off": an existing session still executes.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintCapability } from "../../shared/src/capability.js";
import { sha256Hex } from "../../shared/src/entries/crypto.js";
import { CREATE_REFUSALS_TOTAL, CREATES_DISABLED_GAUGE, metrics } from "@x402s/shared/runtime";
import { loadConfig } from "../../api/src/config.js";
import { createSessionsRouter } from "../../api/src/routes/sessions.js";
import { CREATES_DISABLED_MESSAGE } from "../../api/src/use-cases/create-session-switch.js";
import { postCreate, SWITCH_OFF } from "../helpers/create-route.js";

const REASON = "payment incident INC-431: facilitator is double-settling";
const NOW = Date.now();

/** The switch answering "on", as the controller's read would. */
function switchOn(reason = REASON) {
  return {
    enabled: true as const,
    reason,
    actor: "eric",
    changedAt: NOW,
    expiresAt: null,
    expired: false,
  };
}

/** A facilitator that works, so a refusal is the switch's doing. */
const settledResourceServer = {
  verifyPayment: vi.fn(async () => ({ isValid: true })),
  settlePayment: vi.fn(async () => ({
    success: true,
    transaction: "0xtx",
    network: "mock:local",
    payer: "0xpayer",
  })),
};

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  settledResourceServer.verifyPayment.mockClear();
  settledResourceServer.settlePayment.mockClear();
});

describe("create kill switch", () => {
  it("refuses a paid create before any payment or capacity work", async () => {
    const result = await postCreate(
      ({ controller }) => {
        controller.readCreateSwitch = vi.fn(async () => switchOn());
      },
      { resourceServer: settledResourceServer },
    );

    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error: "creates_disabled",
      retryable: true,
      message: REASON,
    });

    // The capacity, intent and settlement paths are untouched. Each of these
    // would have moved money or held capacity for a session nobody will get.
    expect(result.controller.preflightCapacity).not.toHaveBeenCalled();
    expect(result.controller.holdCapacity).not.toHaveBeenCalled();
    expect(result.controller.claimIntent).not.toHaveBeenCalled();
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    expect(result.controller.reserveBudget).not.toHaveBeenCalled();
    expect(result.controller.burnChallengeNonce).not.toHaveBeenCalled();
    expect(result.controller.authorizeAllowlistedPayer).not.toHaveBeenCalled();
    expect(settledResourceServer.verifyPayment).not.toHaveBeenCalled();
    expect(settledResourceServer.settlePayment).not.toHaveBeenCalled();
    // No 402, so no challenge nonce was minted for a payment that cannot be used.
    expect(result.payment402).not.toHaveBeenCalled();
  });

  it("refuses an unpaid quote instead of returning a 402 challenge", async () => {
    const result = await postCreate(
      ({ controller }) => {
        controller.readCreateSwitch = vi.fn(async () => switchOn());
      },
      { unpaid: true, resourceServer: settledResourceServer },
    );

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: "creates_disabled", retryable: true });
    expect(result.payment402).not.toHaveBeenCalled();
    expect(result.controller.preflightCapacity).not.toHaveBeenCalled();
  });

  it("says what the caller can do when the operator left no reason", async () => {
    const result = await postCreate(
      ({ controller }) => {
        controller.readCreateSwitch = vi.fn(async () => switchOn(""));
      },
      { resourceServer: settledResourceServer },
    );

    expect(result.body).toMatchObject({ message: CREATES_DISABLED_MESSAGE });
    expect(CREATES_DISABLED_MESSAGE).toContain("existing sessions are unaffected");
  });

  it("admits the normal paid path when the switch is off", async () => {
    const result = await postCreate(({ controller }) => {
      controller.readCreateSwitch = vi.fn(async () => SWITCH_OFF);
    }, { resourceServer: settledResourceServer });

    expect(result.status).toBe(201);
    expect(result.controller.holdCapacity).toHaveBeenCalledTimes(1);
    expect(result.controller.claimIntent).toHaveBeenCalledTimes(1);
    expect(result.controller.completeIntent).toHaveBeenCalledTimes(1);
    expect(settledResourceServer.settlePayment).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the switch cannot be read, and takes no payment", async () => {
    const result = await postCreate(
      ({ controller }) => {
        controller.readCreateSwitch = vi.fn(async () => {
          throw new Error("control plane unavailable");
        });
      },
      { resourceServer: settledResourceServer },
    );

    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error: "admission_unavailable",
      retryable: true,
      message: "the create switch could not be read; try again shortly, no payment was taken",
    });
    expect(result.controller.holdCapacity).not.toHaveBeenCalled();
    expect(result.controller.claimIntent).not.toHaveBeenCalled();
    expect(settledResourceServer.settlePayment).not.toHaveBeenCalled();
    expect(result.payment402).not.toHaveBeenCalled();
  });
});

/**
 * The other half of "emergency stop": sessions that already exist keep working.
 * The switch is consulted by the create use case and nowhere else, so an exec on
 * a live session reaches the controller while creates are refused. This drives
 * the real session router, not a mock of it.
 */
describe("live sessions while creates are disabled", () => {
  const SESSION_ID = `sbx_${"7".repeat(24)}`;
  const PAYMENT_KEY = "b".repeat(64);
  const API_SECRET = "s".repeat(32);
  const CAPABILITY = mintCapability({ id: "k1", secret: API_SECRET }, PAYMENT_KEY, "c".repeat(43));

  async function startApi(): Promise<{ base: string; operations: ReturnType<typeof vi.fn> }> {
    const operations = vi.fn(async (_id: string, body: Record<string, unknown>) => ({
      state: "ACTIVE",
      requestId: body.requestId as string,
      envelope: "AAAA",
    }));
    const view = {
      sessionId: SESSION_ID,
      state: "READY",
      tier: "standard",
      durationSeconds: 300,
      limits: {},
      createdAt: NOW,
      remainingSeconds: 300,
      clientNonce: "d".repeat(43),
      clientPublicKey: "e".repeat(43),
      capabilityHash: sha256Hex(CAPABILITY),
      capabilityExpiresAt: NOW + 60_000,
      busy: false,
    };
    const config = loadConfig({
      PAYMENT_MODE: "mock",
      ALLOW_INSECURE_DEV: "true",
      CONTROLLER_ADMIN_TOKEN: "a".repeat(32),
      CAPABILITY_SECRET: API_SECRET,
      CAPABILITY_KEY_ID: "k1",
    });
    const app = express();
    app.use(express.json());
    app.use(
      createSessionsRouter({
        config,
        controller: {
          async getSession() {
            return view;
          },
          operation: operations,
        },
      } as never),
    );
    const server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    servers.push(server);
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, operations };
  }

  it("still executes on an existing session", async () => {
    const { base, operations } = await startApi();

    const res = await fetch(`${base}/v1/sessions/${SESSION_ID}/operations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sandbox-capability": CAPABILITY,
      },
      body: JSON.stringify({ requestId: "kill-switch-live-1", envelope: "AAAA" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      requestId: "kill-switch-live-1",
      envelope: "AAAA",
    });
    expect(operations).toHaveBeenCalledTimes(1);
  });
});

/**
 * The two families an operator and an alert rule read. The gauge answers "is it
 * on right now" without create traffic on the much larger question of whether
 * the API agrees with the row; the counter is refusals by code.
 */
describe("kill switch metrics", () => {
  function sample(text: string, series: string): number | null {
    const line = text.split("\n").find((row) => row.startsWith(`${series} `));
    return line === undefined ? null : Number(line.slice(series.length + 1));
  }

  /** The registry caches rendered text for 500 ms. */
  async function rendered(): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 520));
    return metrics.render();
  }

  it("publishes the gauge and counts the refusal by code, never by reason", async () => {
    const before = await rendered();
    const result = await postCreate(
      ({ controller }) => {
        controller.readCreateSwitch = vi.fn(async () => switchOn());
      },
      { resourceServer: settledResourceServer },
    );
    expect(result.status).toBe(503);
    const after = await rendered();

    expect(sample(after, CREATES_DISABLED_GAUGE)).toBe(1);
    const series = `${CREATE_REFUSALS_TOTAL}{error="creates_disabled"}`;
    expect(sample(after, series)).toBe((sample(before, series) ?? 0) + 1);
    // The operator's reason is free text and the actor is a name: neither is a
    // label value.
    expect(after).not.toContain(REASON);
    expect(after).not.toContain("eric");
  });

  it("drops the gauge back to zero when the switch is read as off", async () => {
    const result = await postCreate(({ controller }) => {
      controller.readCreateSwitch = vi.fn(async () => SWITCH_OFF);
    }, { resourceServer: settledResourceServer });
    expect(result.status).toBe(201);

    const text = await rendered();
    expect(sample(text, CREATES_DISABLED_GAUGE)).toBe(0);
  });
});
