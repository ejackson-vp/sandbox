/**
 * Session lifecycle at the SDK boundary.
 *
 * What matters here is the shape of what leaves the client and what it keeps:
 * the create request must carry the resources the caller asked for and nothing
 * else (the server rejects a `custom` tier with no resources, and a zero
 * duration is not a request to default), a rejected payment must surface as
 * `payment_rejected` rather than a generic create failure, and a handle read
 * back from the local store must be bound to the same API it was created
 * against.
 *
 * The payer is injected, which is the seam the client already offers, so no
 * wallet or facilitator is involved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxClient } from "../../sdk/src/client.js";
import type { Payer } from "../../sdk/src/payment.js";
import type { FileSessionStore, StoredSession } from "../../sdk/src/session-store.js";
import { SandboxError, SessionExpiredError, type SessionHandle } from "../../sdk/src/types.js";

const SESSION_ID = "sbx_00ff00ff00ff00ff00ff00ff";
const API = "http://api.test";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface PayerHarness {
  payer: Payer;
  bodies: Array<Record<string, unknown>>;
}

function payer(answer: Response, extra: { paymentError?: string } = {}): PayerHarness {
  const bodies: Array<Record<string, unknown>> = [];
  return {
    bodies,
    payer: {
      mode: "mock",
      signMessage: async () => "0xsignature",
      async createSession(_apiUrl, body) {
        bodies.push(body as unknown as Record<string, unknown>);
        return {
          response: answer,
          priceUsd: "0.05",
          network: "mock:local",
          mode: "mock",
          payer: "0x0000000000000000000000000000000000000001",
          ...extra,
        };
      },
    },
  };
}

/** A create response in the shape the controller returns. */
function createdResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      sessionId: SESSION_ID,
      capability: "capability-token",
      state: "PAID",
      tier: "standard",
      durationSeconds: 300,
      limits: { cpuMillis: 500, memoryMiB: 512, diskMiB: 256 },
      payment: {
        mode: "mock",
        network: "mock:local",
        scheme: "exact",
        asset: "mock:usdc",
        amount: "50000",
        priceUsd: "0.05",
        payTo: "0x0000000000000000000000000000000000000402",
      },
      ...overrides,
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}

function memoryStore(): { store: FileSessionStore; rows: Map<string, StoredSession> } {
  const rows = new Map<string, StoredSession>();
  const store = {
    save: (row: StoredSession) => rows.set(row.sessionId, row),
    get: (id: string) => rows.get(id) ?? null,
    list: () => [...rows.values()],
    remove: (id: string) => rows.delete(id),
  } as unknown as FileSessionStore;
  return { store, rows };
}

function clientWith(harness: PayerHarness, store?: FileSessionStore): SandboxClient {
  return new SandboxClient({
    apiUrl: API,
    payer: harness.payer,
    paymentMode: "mock",
    allowInsecureDev: true,
    ...(store ? { store } : {}),
  });
}

describe("createSession", () => {
  it("asks for a custom tier only when resources were named, and sends only those", async () => {
    const harness = payer(createdResponse());
    await clientWith(harness).createSession({ cpuMillis: 750, memoryMiB: 1024 });

    const body = harness.bodies[0]!;
    expect(body).toMatchObject({
      tier: "custom",
      cpuMillis: 750,
      memoryMiB: 1024,
      clientNonce: expect.any(String),
      clientPublicKey: expect.any(String),
    });
    // A field the caller did not set must not be invented: the server's own
    // defaults are what the pricing quoted.
    expect(body).not.toHaveProperty("durationSeconds");
    expect(body).not.toHaveProperty("diskMiB");
    expect(body).not.toHaveProperty("maxLifetimeSeconds");
  });

  it("keeps an explicit tier and carries the optional fields that were set", async () => {
    const harness = payer(createdResponse());
    await clientWith(harness).createSession({
      tier: "standard",
      durationSeconds: 120,
      runtime: "python",
      maxLifetimeSeconds: 600,
      idlePolicy: { maxIdleSeconds: 60 },
    });

    expect(harness.bodies[0]).toMatchObject({
      tier: "standard",
      durationSeconds: 120,
      runtime: "python",
      maxLifetimeSeconds: 600,
      idlePolicy: { maxIdleSeconds: 60 },
    });
  });

  it("returns a handle whose status came from the create response", async () => {
    const harness = payer(createdResponse());
    const handle = await clientWith(harness).createSession({ tier: "standard" });

    expect(handle).toMatchObject({ sessionId: SESSION_ID, capability: "capability-token" });
    expect(handle.status).toMatchObject({ state: "PAID", tier: "standard", durationSeconds: 300 });
    expect(handle.clientPublicKey).toHaveLength(32);
    expect(handle.clientPrivateKey).toHaveLength(32);
    // The nonce is the one this client generated, not whatever the server echoed.
    expect(handle.status?.clientNonce).toBe(handle.clientNonce);
  });

  it("prefers the folded session view when the server sends one", async () => {
    const harness = payer(
      createdResponse({
        session: {
          sessionId: SESSION_ID,
          state: "READY",
          tier: "standard",
          durationSeconds: 300,
          limits: {},
          createdAt: new Date().toISOString(),
          remainingSeconds: 300,
          clientNonce: "server-nonce",
          busy: false,
          payment: { mode: "mock", network: "mock:local", scheme: "exact", asset: "mock:usdc", amount: "50000", priceUsd: "0.05", payTo: "0x0" },
        },
      }),
    );
    const handle = await clientWith(harness).createSession();
    expect(handle.status).toMatchObject({ state: "READY" });
    expect(handle.status?.clientNonce).toBe(handle.clientNonce);
  });

  it("reports a rejected payment as payment_rejected, not as a create failure", async () => {
    const harness = payer(createdResponse({ error: "payment_invalid:bad_signature" }), {
      paymentError: "payment_invalid:bad_signature",
    });
    const error = await clientWith(harness)
      .createSession()
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({ code: "payment_rejected", status: 201 });
    expect((error as SandboxError).message).toContain("bad_signature");
  });

  it("surfaces the server's error code for a refused create", async () => {
    const harness = payer(
      new Response(JSON.stringify({ error: "capacity_unavailable", message: "no nodes" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(clientWith(harness).createSession()).rejects.toMatchObject({
      code: "capacity_unavailable",
      status: 503,
    });
  });

  it("falls back to create_failed when the refusal is not JSON", async () => {
    const harness = payer(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(clientWith(harness).createSession()).rejects.toMatchObject({
      code: "create_failed",
      status: 502,
    });
  });

  it("persists the handle unless the caller opts out", async () => {
    const { store, rows } = memoryStore();
    await clientWith(payer(createdResponse()), store).createSession();
    expect(rows.get(SESSION_ID)).toMatchObject({ apiUrl: API, capability: "capability-token", tier: "standard" });

    rows.clear();
    await clientWith(payer(createdResponse()), store).createSession({ save: false });
    expect(rows.size).toBe(0);
  });
});

describe("attach", () => {
  const stored: StoredSession = {
    apiUrl: API,
    sessionId: SESSION_ID,
    capability: "capability-token",
    clientPublicKey: Buffer.alloc(32, 1).toString("base64"),
    clientPrivateKey: Buffer.alloc(32, 2).toString("base64"),
    clientNonce: "nonce",
    createdAt: 1,
    guestPublicKey: Buffer.alloc(32, 3).toString("base64"),
  };

  it("rebuilds the handle, including the pinned guest key", async () => {
    const { store } = memoryStore();
    store.save(stored);
    const handle = clientWith(payer(createdResponse()), store).attach(SESSION_ID);

    expect(handle).toMatchObject({ sessionId: SESSION_ID, capability: "capability-token", clientNonce: "nonce" });
    expect(handle.clientPrivateKey).toEqual(new Uint8Array(Buffer.alloc(32, 2)));
    expect(handle.guestPublicKey).toEqual(new Uint8Array(Buffer.alloc(32, 3)));
  });

  it("refuses to attach when this client has no store", () => {
    expect(() => clientWith(payer(createdResponse())).attach(SESSION_ID)).toThrow(SandboxError);
  });

  it("refuses an id the store does not hold", () => {
    const { store } = memoryStore();
    expect(() => clientWith(payer(createdResponse()), store).attach(SESSION_ID)).toThrow(/no local credentials/);
  });

  it("refuses a session created against another API", () => {
    const { store } = memoryStore();
    store.save({ ...stored, apiUrl: "http://other.test" });
    const error = (() => {
      try {
        return clientWith(payer(createdResponse()), store).attach(SESSION_ID);
      } catch (err) {
        return err as SandboxError;
      }
    })();
    expect(error).toMatchObject({ code: "api_mismatch" });
  });

  it("lists and forgets through the same store", () => {
    const { store } = memoryStore();
    store.save(stored);
    const sdk = clientWith(payer(createdResponse()), store);
    expect(sdk.listLocalSessions()).toHaveLength(1);
    sdk.forgetLocal(SESSION_ID);
    expect(sdk.listLocalSessions()).toEqual([]);
  });
});

describe("suspend, resume and destroy", () => {
  const handle = (): SessionHandle => ({
    sessionId: SESSION_ID,
    capability: "capability-token",
    clientPublicKey: new Uint8Array(32),
    clientPrivateKey: new Uint8Array(32),
    clientNonce: "nonce",
    createdAt: 0,
  });

  it("returns the suspended status and records it on the handle", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ sessionId: SESSION_ID, state: "SUSPENDED", tier: "standard" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const local = handle();
    const status = await clientWith(payer(createdResponse())).suspend(local);
    expect(status).toMatchObject({ state: "SUSPENDED" });
    expect(local.status).toMatchObject({ state: "SUSPENDED" });
  });

  it("surfaces a refused suspend with the API's own code", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: "lease_expired", message: "gone" }), {
        status: 410,
        headers: { "content-type": "application/json" },
      }));
    await expect(clientWith(payer(createdResponse())).suspend(handle())).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("surfaces a refused resume", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: "not_suspendable", message: "no checkpoint" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }));
    await expect(clientWith(payer(createdResponse())).resume(handle())).rejects.toMatchObject({
      code: "not_suspendable",
      status: 409,
    });
  });

  it("destroys then waits for the terminal state", async () => {
    const methods: string[] = [];
    let polls = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      methods.push(init.method ?? "GET");
      if (init.method === "DELETE") return new Response(null, { status: 202 });
      polls += 1;
      const state = polls < 2 ? "TERMINATING" : "DESTROYED";
      return new Response(JSON.stringify({ sessionId: SESSION_ID, state }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const status = await clientWith(payer(createdResponse())).destroy(handle(), 5_000);
    expect(status).toMatchObject({ state: "DESTROYED" });
    expect(methods[0]).toBe("DELETE");
  });

  it("answers null when the capability is gone before the session is", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      if (init.method === "DELETE") return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ error: "capability_expired" }), {
        status: 410,
        headers: { "content-type": "application/json" },
      });
    });
    expect(await clientWith(payer(createdResponse())).destroy(handle(), 500)).toBeNull();
  });
});
