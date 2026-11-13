/**
 * The facilitator port: timeouts, bounded retries and refusal handling.
 *
 * Every case runs against a real HTTP server on loopback, so the client's
 * timeout, retry and body handling are exercised rather than mocked. No live
 * facilitator or chain is involved.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  FacilitatorError,
  X402FacilitatorClient,
} from "../../api/src/payments/facilitator-client.js";

const PAYLOAD = { x402Version: 2, payload: { authorization: {} } } as unknown as PaymentPayload;
const REQUIREMENTS = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "50000",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 300,
} as unknown as PaymentRequirements;

interface FakeFacilitator {
  url: string;
  requests: Array<{ path: string; authorization?: string; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** One loopback server per test, with the handler supplied by the test. */
async function fakeFacilitator(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<FakeFacilitator> {
  const requests: FakeFacilitator["requests"] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({
        path: req.url ?? "",
        authorization: req.headers.authorization as string | undefined,
        body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
      });
      handler(req, res);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}/facilitator`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

let running: FakeFacilitator | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("facilitator client", () => {
  it("verifies with the x402 v2 request shape", async () => {
    running = await fakeFacilitator((_req, res) =>
      json(res, 200, { isValid: true, payer: "0x1111111111111111111111111111111111111111" }),
    );
    const client = new X402FacilitatorClient({ baseUrl: running.url, retryBaseMs: 1 });

    const result = await client.verify(PAYLOAD, REQUIREMENTS);

    expect(result.isValid).toBe(true);
    expect(running.requests).toHaveLength(1);
    expect(running.requests[0]?.path).toBe("/facilitator/verify");
    expect(running.requests[0]?.body).toMatchObject({
      x402Version: 2,
      paymentPayload: PAYLOAD,
      paymentRequirements: REQUIREMENTS,
    });
  });

  it("returns a verify refusal instead of throwing", async () => {
    running = await fakeFacilitator((_req, res) =>
      json(res, 400, { isValid: false, invalidReason: "invalid_signature" }),
    );
    const client = new X402FacilitatorClient({ baseUrl: running.url, retryBaseMs: 1 });

    await expect(client.verify(PAYLOAD, REQUIREMENTS)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_signature",
    });
  });

  it("returns a settle refusal instead of throwing", async () => {
    running = await fakeFacilitator((_req, res) =>
      json(res, 400, {
        success: false,
        errorReason: "insufficient_funds",
        transaction: "",
        network: "eip155:84532",
      }),
    );
    const client = new X402FacilitatorClient({ baseUrl: running.url, retryBaseMs: 1 });

    await expect(client.settle(PAYLOAD, REQUIREMENTS)).resolves.toMatchObject({
      success: false,
      errorReason: "insufficient_funds",
    });
  });

  it("throws a typed error when a 4xx is not a protocol answer", async () => {
    running = await fakeFacilitator((_req, res) => json(res, 403, { message: "not allowed" }));
    const client = new X402FacilitatorClient({ baseUrl: running.url, retryBaseMs: 1 });

    await expect(client.settle(PAYLOAD, REQUIREMENTS)).rejects.toBeInstanceOf(FacilitatorError);
  });

  it("times out and never retries settle", async () => {
    // No response at all: the settle outcome is `unknown`, and the client must
    // not send a second one.
    running = await fakeFacilitator(() => undefined);
    const client = new X402FacilitatorClient({
      baseUrl: running.url,
      timeoutMs: 30,
      retryBaseMs: 1,
    });

    await expect(client.settle(PAYLOAD, REQUIREMENTS)).rejects.toThrow();
    expect(running.requests).toHaveLength(1);
  });

  it("retries a 5xx verify a bounded number of times", async () => {
    running = await fakeFacilitator((_req, res) => json(res, 503, { error: "busy" }));
    const client = new X402FacilitatorClient({
      baseUrl: running.url,
      retries: 2,
      retryBaseMs: 1,
    });

    await expect(client.verify(PAYLOAD, REQUIREMENTS)).rejects.toBeInstanceOf(FacilitatorError);
    expect(running.requests).toHaveLength(3);
  });

  it("recovers a 5xx verify on the retry", async () => {
    let calls = 0;
    running = await fakeFacilitator((_req, res) => {
      calls += 1;
      if (calls === 1) {
        json(res, 502, { error: "bad gateway" });
        return;
      }
      json(res, 200, { isValid: true });
    });
    const client = new X402FacilitatorClient({ baseUrl: running.url, retryBaseMs: 1 });

    await expect(client.verify(PAYLOAD, REQUIREMENTS)).resolves.toMatchObject({ isValid: true });
    expect(running.requests).toHaveLength(2);
  });

  it("attaches the auth headers the provider returns, per request", async () => {
    running = await fakeFacilitator((_req, res) => json(res, 200, { isValid: true }));
    const client = new X402FacilitatorClient({
      baseUrl: running.url,
      auth: {
        headers: (method, url) => ({ authorization: `test ${method} ${url.pathname}` }),
      },
    });

    await client.verify(PAYLOAD, REQUIREMENTS);
    expect(running.requests[0]?.authorization).toBe("test POST /facilitator/verify");
  });

  it("constructs with a bare configuration", () => {
    expect(
      new X402FacilitatorClient({ baseUrl: "https://facilitator.example.test/" }),
    ).toBeInstanceOf(X402FacilitatorClient);
  });
});
