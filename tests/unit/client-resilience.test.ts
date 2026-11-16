import { afterEach, describe, expect, it, vi } from "vitest";
import { generateBoxKeyPair } from "@x402s/shared/crypto";
import { SandboxClient } from "../../sdk/src/client.js";
import type { SessionHandle } from "../../sdk/src/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const handle = {
  sessionId: "sbx_restart",
  capability: "cap",
  clientPublicKey: new Uint8Array(32),
  clientPrivateKey: new Uint8Array(32),
  clientNonce: "nonce",
  createdAt: 0,
} satisfies SessionHandle;

function client(): SandboxClient {
  return new SandboxClient({
    apiUrl: "http://api.test",
    paymentMode: "mock",
    allowInsecureDev: true,
  });
}

describe("operation lookups after a restart", () => {
  it("surfaces a fenced request as outcome_unknown, distinct from a never-seen id", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ error: "outcome_unknown", message: "the controller restarted while this operation was in flight" }),
        { status: 409, headers: { "content-type": "application/json" } },
      ));
    await expect(client().getOperation(handle, "req-fenced", 0)).rejects.toMatchObject({
      code: "outcome_unknown",
      status: 409,
      requestId: "req-fenced",
    });
  });

  it("reports a never-seen request as request_not_found", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: "request_not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }));
    await expect(client().getOperation(handle, "req-never", 0)).rejects.toMatchObject({
      code: "request_not_found",
      status: 404,
    });
  });
});

describe("a refusal the client cannot read", () => {
  it("names the fallback code when a 409 body is not JSON", async () => {
    vi.stubGlobal("fetch", async () => new Response("gateway said no", { status: 409 }));
    const guest = await generateBoxKeyPair();

    await expect(
      client().exec({ ...handle, guestPublicKey: guest.publicKey }, { command: ["true"] }),
    ).rejects.toMatchObject({
      code: "exec_failed",
      status: 409,
      message: "gateway said no",
    });
  });

  it("keeps the read surface's own fallback on the GET path", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>nope</html>", { status: 409 }));
    const guest = await generateBoxKeyPair();

    await expect(
      client().getFile({ ...handle, guestPublicKey: guest.publicKey }, "/workspace/a.txt"),
    ).rejects.toMatchObject({
      code: "file_operation_failed",
      status: 409,
    });
  });
});

describe("waitForReady transport resilience", () => {
  it("retries a transient API transport failure instead of reporting it as a session failure", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ sessionId: handle.sessionId, state: "FAILED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // The second response proves the retry happened; the session itself is
    // then failed, which is a real terminal state and should surface.
    await expect(client().waitForReady(handle, 2_000)).rejects.toMatchObject({ code: "session_failed" });
    expect(calls).toBe(2);
  });

  it("retries a 503 from a restarting API", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "unavailable", message: "starting" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ sessionId: handle.sessionId, state: "FAILED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(client().waitForReady(handle, 2_000)).rejects.toMatchObject({ code: "session_failed" });
    expect(calls).toBe(2);
  });

  it("surfaces the transport error when the API never answers", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    });

    await expect(client().waitForReady(handle, 300)).rejects.toThrow("fetch failed");
    expect(calls).toBeGreaterThan(1);
  });
});
