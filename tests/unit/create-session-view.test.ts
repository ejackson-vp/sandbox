/**
 * Create response session view: the API folds the controller view into the
 * create response and the SDK consumes it, so a create needs no immediate
 * status request. The legacy response fields must stay intact for old clients,
 * and a response without the view must still produce a usable handle.
 */
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_ASSET, MOCK_NETWORK } from "../../shared/src/payment.js";
import type { ControllerSessionView } from "../../shared/src/index.js";
import { createResponseFrom, toStatus } from "../../api/src/status.js";
import { SandboxClient } from "../../sdk/src/index.js";
import type { CreateSessionResponse, SessionStatus } from "../../shared/src/index.js";

const requirement = {
  scheme: "exact",
  network: MOCK_NETWORK,
  asset: MOCK_ASSET,
  amount: "10000",
  payTo: "0x0000000000000000000000000000000000000402",
  maxTimeoutSeconds: 300,
  extra: { tier: "short", durationSeconds: 60 },
};

const paymentRequired = {
  x402Version: 2,
  resource: { url: "https://sandbox.test/v1/sessions", description: "create a sandbox" },
  accepts: [requirement],
};

const view: ControllerSessionView = {
  sessionId: "sbx_embedded",
  state: "PAID",
  tier: "short",
  durationSeconds: 60,
  limits: {
    cpuMillis: 1000,
    memoryMiB: 1024,
    diskMiB: 1024,
    maxOutputBytes: 262144,
    maxFileBytes: 8388608,
    maxCommandSeconds: 60,
    maxProcesses: 256,
  },
  createdAt: Date.parse("2026-11-10T10:00:00.000Z"),
  remainingSeconds: 60,
  clientNonce: "server-nonce",
  clientPublicKey: "server-client-public-key",
  capabilityHash: "a".repeat(64),
  capabilityExpiresAt: Date.parse("2026-11-10T10:20:00.000Z"),
  busy: false,
  payment: {
    paymentKey: "b".repeat(64),
    network: MOCK_NETWORK,
    scheme: "exact",
    asset: MOCK_ASSET,
    amount: "10000",
    payTo: requirement.payTo,
    payer: "0x0000000000000000000000000000000000000001",
    transaction: "mock:tx",
    mode: "mock",
  },
};

const publicView = toStatus(view);

function challenge(): Response {
  return new Response(JSON.stringify({ error: "payment_required" }), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "payment-required": encodePaymentRequiredHeader(paymentRequired),
    },
  });
}

function createResponse(withView: boolean): Response {
  const body: CreateSessionResponse = {
    sessionId: view.sessionId,
    capability: "capability-token",
    state: view.state,
    tier: view.tier,
    durationSeconds: view.durationSeconds,
    limits: view.limits,
    capabilityExpiresAt: new Date(view.capabilityExpiresAt).toISOString(),
    clientNonce: view.clientNonce,
    payment: publicView.payment,
    ...(withView ? { session: publicView } : {}),
  };
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

/** Count every fetch the SDK makes on the create path. */
function stubCreate(withView: boolean): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1;
      return calls === 1 ? challenge() : createResponse(withView);
    }),
  );
  return { calls: () => calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("create response session view", () => {
  it("embeds the public status view and no internal fields", () => {
    const body = createResponseFrom(view, "capability-token", view.limits);
    expect(body.session).toEqual(publicView);
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("capabilityHash");
    expect(wire).not.toContain(view.capabilityHash);
    expect(wire).not.toContain(view.payment.paymentKey);
  });

  it("keeps every legacy field an old client reads", () => {
    const body = createResponseFrom(view, "capability-token", view.limits);
    const legacy: CreateSessionResponse = {
      sessionId: body.sessionId,
      capability: body.capability,
      state: body.state,
      tier: body.tier,
      durationSeconds: body.durationSeconds,
      limits: body.limits,
      ...(body.baseline ? { baseline: body.baseline } : {}),
      capabilityExpiresAt: body.capabilityExpiresAt,
      clientNonce: body.clientNonce,
      payment: body.payment,
    };
    expect(legacy).toMatchObject({
      sessionId: view.sessionId,
      capability: "capability-token",
      state: "PAID",
      tier: "short",
      durationSeconds: 60,
      capabilityExpiresAt: new Date(view.capabilityExpiresAt).toISOString(),
      clientNonce: view.clientNonce,
    });
    // The new field is additive: everything except `session` is unchanged.
    expect(Object.keys(body).filter((key) => key !== "session")).toEqual(Object.keys(legacy));
  });

  it("builds the SDK handle from the embedded view without a status request", async () => {
    const fetches = stubCreate(true);
    const client = new SandboxClient({ apiUrl: "https://sandbox.test", paymentMode: "mock" });
    const handle = await client.createSession({ tier: "short", durationSeconds: 60 });

    // One unpaid probe (402) and one paid create. A post-create getSession
    // would be a third request.
    expect(fetches.calls()).toBe(2);
    expect(handle.status?.createdAt).toBe(publicView.createdAt);
    expect(handle.status?.remainingSeconds).toBe(60);
    expect(handle.status?.payment.priceUsd).toBe("$0.01");
    // The view is bound to this client's nonce, not the server's echo.
    expect(handle.status?.clientNonce).toBe(handle.clientNonce);
    expect(handle.status?.clientNonce).not.toBe(view.clientNonce);
  });

  it("falls back to a locally derived view when an old server omits it", async () => {
    const fetches = stubCreate(false);
    const client = new SandboxClient({ apiUrl: "https://sandbox.test", paymentMode: "mock" });
    const handle = await client.createSession({ tier: "short", durationSeconds: 60 });

    expect(fetches.calls()).toBe(2);
    const status: SessionStatus | undefined = handle.status;
    expect(status?.sessionId).toBe(view.sessionId);
    expect(status?.state).toBe("PAID");
    expect(status?.durationSeconds).toBe(60);
    expect(status?.remainingSeconds).toBe(60);
    expect(status?.busy).toBe(false);
    expect(Number.isNaN(Date.parse(status!.createdAt))).toBe(false);
  });
});
