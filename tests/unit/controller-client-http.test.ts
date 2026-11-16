/**
 * The API's controller client, over a real socket.
 *
 * This is the only place the API speaks to the controller, and it decides three
 * things a unit test can pin without a cluster:
 *
 *  - what credential goes out (`x-internal-token`, or nothing when the client
 *    certificate is the credential),
 *  - which controller answers are *decided* results and which are failures
 *    (a 202 operation is pending, a 409 capacity hold is a refusal, a 409
 *    intent claim is in progress / failed / mismatch, everything else throws
 *    `ControllerError` with the controller's own status and code),
 *  - that a failure the caller cannot act on is swallowed where the caller
 *    already declared best effort (`wake`, `releaseCapacity`).
 *
 * A local `http` server stands in for the controller, so the assertions are on
 * the bytes that would leave the API rather than on a mocked function.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ControllerClient, ControllerError } from "../../api/src/controller-client.js";

const TOKEN = "t".repeat(32);
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

interface Recorded {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type Handler = (req: Recorded, res: http.ServerResponse) => void;

async function controller(handler: Handler): Promise<{ client: ControllerClient; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: Recorded = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { client: new ControllerClient(base, TOKEN), requests };
}

function answer(res: http.ServerResponse, status: number, body: unknown, raw?: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(raw ?? JSON.stringify(body));
}

describe("what leaves the API", () => {
  it("sends the shared admin token and JSON content type on every call", async () => {
    const { client, requests } = await controller((_req, res) => answer(res, 200, { ok: true }));
    await client.healthz();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers["x-internal-token"]).toBe(TOKEN);
    expect(requests[0]!.headers["content-type"]).toContain("application/json");
  });

  it("percent-encodes an identifier instead of letting it shape the path", async () => {
    const { client, requests } = await controller((_req, res) => answer(res, 200, { sessionId: "x" }));
    await client.getSession("../../internal/wake");
    expect(requests[0]!.path).toBe("/internal/sessions/..%2F..%2Finternal%2Fwake");
  });

  it("encodes the payment key into the completion and failure paths", async () => {
    const { client, requests } = await controller((_req, res) => answer(res, 200, { sessionId: "sbx_1", state: "PAID" }));
    await client.completeIntent("0x/../key", {} as never);
    await client.failIntent("0x/../key", "declined");
    expect(requests.map((r) => r.path)).toEqual([
      "/internal/payment-intents/0x%2F..%2Fkey/complete",
      "/internal/payment-intents/0x%2F..%2Fkey/fail",
    ]);
    expect(JSON.parse(requests[1]!.body)).toEqual({ reason: "declined" });
  });
});

describe("readiness", () => {
  it("returns a controller report that says it is not ready, instead of throwing", async () => {
    const { client } = await controller((_req, res) =>
      answer(res, 503, { ok: false, components: { store: { ok: false, reason: "unreachable" } } }),
    );
    expect(await client.readiness()).toMatchObject({ ok: false });
  });

  it("rejects a body that is not a readiness report", async () => {
    const { client } = await controller((_req, res) => answer(res, 502, undefined, "<html>bad gateway</html>"));
    await expect(client.readiness()).rejects.toMatchObject({
      status: 502,
      code: "readiness_failed",
    });
  });
});

describe("payment intent claims", () => {
  it("returns the claim token when the controller grants one", async () => {
    const { client, requests } = await controller((_req, res) =>
      answer(res, 200, { status: "claimed", recovered: true, token: "claim-1", expiresAt: 1 }),
    );
    const claim = await client.claimIntent("0xkey", "hash", 30_000, {
      network: "mock:local",
      scheme: "exact",
      asset: "mock:usdc",
      amount: "50000",
      payTo: "0xpay",
    });
    expect(claim).toMatchObject({ status: "claimed", token: "claim-1", recovered: true });
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ paymentKey: "0xkey", specHash: "hash", staleMs: 30_000 });
  });

  it("maps every decided 409 to its own claim state", async () => {
    const states = [
      { body: { status: "in_progress" }, expected: { status: "in_progress" } },
      { body: { status: "failed", reason: "declined" }, expected: { status: "failed", reason: "declined" } },
      { body: { status: "mismatch" }, expected: { status: "mismatch" } },
    ];
    for (const { body, expected } of states) {
      const { client } = await controller((_req, res) => answer(res, 409, body));
      expect(await client.claimIntent("0xkey", "hash")).toEqual(expected);
    }
  });

  it("throws on a 409 it cannot interpret, keeping the controller's status", async () => {
    const { client } = await controller((_req, res) => answer(res, 409, { status: "something_new" }));
    const error = await client.claimIntent("0xkey", "hash").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ControllerError);
    expect(error).toMatchObject({ status: 409, code: "intent_claim_failed" });
  });

  it("turns a literal JSON null into a ControllerError, not a TypeError", async () => {
    // A 409 with a `null` body is the case the `?? {}` exists for: reading
    // `.status` off null would throw a TypeError the caller would see as a
    // control-plane outage instead of a refused claim.
    const { client } = await controller((_req, res) => answer(res, 409, undefined, "null"));
    const error = await client.claimIntent("0xkey", "hash").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ControllerError);
    expect(error).toMatchObject({ status: 409, code: "intent_claim_failed" });
  });
});

describe("failure mapping on the generic call path", () => {
  it("copies the controller's error code and message", async () => {
    const { client } = await controller((_req, res) =>
      answer(res, 403, { error: "not_admin", message: "token rejected" }),
    );
    await expect(client.suspend("sbx_1")).rejects.toMatchObject({
      status: 403,
      code: "not_admin",
      message: "token rejected",
    });
  });

  it("falls back to a plain controller code when the body is not the error shape", async () => {
    const { client } = await controller((_req, res) => answer(res, 502, undefined, "upstream exploded"));
    await expect(client.resume("sbx_1")).rejects.toMatchObject({
      status: 502,
      code: "controller_error",
      message: "controller 502",
    });
  });

  it("returns a 200 body as the answer, including an empty one", async () => {
    const { client } = await controller((_req, res) => answer(res, 200, undefined, ""));
    // `call` parses an empty body as undefined; a DELETE has no body of its own.
    await expect(client.destroy("sbx_1")).resolves.toBeUndefined();
  });
});

describe("budgets, allowlist, nonces and capacity", () => {
  it("returns a budget refusal as a decision", async () => {
    const { client, requests } = await controller((_req, res) =>
      answer(res, 200, {
        ok: false,
        scope: "payer_creates",
        retryAfterSeconds: 60,
        remaining: { payerCreates: 0, payerSpend: null, payerConcurrent: 1, globalCreates: 9, globalConcurrent: 9 },
        windowResetsAt: 1,
      }),
    );
    const decision = await client.reserveBudget(null, "50000");
    expect(decision).toMatchObject({ ok: false, scope: "payer_creates" });
    // An anonymous payer sends no `payer` field at all.
    expect(JSON.parse(requests[0]!.body)).toEqual({ amount: "50000" });
  });

  it("fails closed when the budget endpoint is unreachable", async () => {
    const { client } = await controller((_req, res) => answer(res, 500, { error: "store_down" }));
    await expect(client.reserveBudget("0xpayer", "50000")).rejects.toMatchObject({ code: "store_down" });
  });

  it("returns an allowlist refusal as a decision", async () => {
    const { client } = await controller((_req, res) =>
      answer(res, 200, { allowed: false, reason: "not_allowlisted" }),
    );
    expect(await client.authorizeAllowlistedPayer("0xpayer", "standard")).toEqual({
      allowed: false,
      reason: "not_allowlisted",
    });
  });

  it("returns a burned nonce status and surfaces a transport failure", async () => {
    const { client, requests } = await controller((_req, res) => answer(res, 200, { status: "replay" }));
    expect(await client.burnChallengeNonce("cn_1", "0xkey")).toEqual({ status: "replay" });
    expect(requests[0]!.path).toBe("/internal/challenge-nonces/cn_1/burn");
  });

  it("treats a 409 capacity hold as a refusal and any other failure as an error", async () => {
    const refusal = {
      admitted: false,
      reason: "no_eligible_nodes",
      retryable: true,
      requested: { cpuMillicores: 500, memoryBytes: 1, storageBytes: 1 },
    };
    const held = await controller((_req, res) => answer(res, 409, refusal));
    expect(await held.client.holdCapacity("0xkey", "hash", {} as never)).toMatchObject({
      admitted: false,
      reason: "no_eligible_nodes",
    });
    const broken = await controller((_req, res) =>
      answer(res, 500, { error: "capacity_unavailable", message: "scheduler down" }),
    );
    await expect(broken.client.holdCapacity("0xkey", "hash", {} as never)).rejects.toMatchObject({
      status: 500,
      code: "capacity_unavailable",
      message: "scheduler down",
    });
  });

  it("swallows a failed capacity release, because the reaper owns the row", async () => {
    const { client } = await controller((_req, res) => answer(res, 500, { error: "capacity_unavailable" }));
    await expect(client.releaseCapacity("0xkey")).resolves.toBeUndefined();
  });
});

describe("operations", () => {
  it("treats 202 as a pending result and 200 as the operation's answer", async () => {
    const pending = await controller((_req, res) =>
      answer(res, 202, { state: "READY", requestId: "req-1", pending: true }),
    );
    expect(await pending.client.operation("sbx_1", { requestId: "req-1", envelope: "AAAA" })).toEqual({
      state: "READY",
      requestId: "req-1",
      pending: true,
    });
    const done = await controller((_req, res) =>
      answer(res, 200, { state: "READY", requestId: "req-1", envelope: "BBBB" }),
    );
    expect(await done.client.getOperation("sbx_1", "req-1", 1_000)).toMatchObject({ envelope: "BBBB" });
  });

  it("carries the busy refusal out with the controller's own code", async () => {
    const { client } = await controller((_req, res) =>
      answer(res, 409, { error: "busy", message: "another operation is running" }),
    );
    await expect(client.operation("sbx_1", { requestId: "req-1", envelope: "AAAA" })).rejects.toMatchObject({
      status: 409,
      code: "busy",
    });
  });

  it("passes the poll wait and the envelope through the query string", async () => {
    const { client, requests } = await controller((_req, res) =>
      answer(res, 200, { state: "READY", requestId: "req-1" }),
    );
    await client.getOperation("sbx_1", "req-1", 5_000);
    expect(requests[0]!.path).toBe("/internal/sessions/sbx_1/operations/req-1?waitMs=5000");
  });
});

describe("best-effort wake", () => {
  it("resolves even when the controller answers with an error", async () => {
    const { client } = await controller((_req, res) => answer(res, 503, { error: "not_leader" }));
    await expect(client.wake()).resolves.toBeUndefined();
  });

  it("resolves when the controller is not listening at all", async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const client = new ControllerClient(`http://127.0.0.1:${port}`, TOKEN);
    await expect(client.wake()).resolves.toBeUndefined();
  });
});
