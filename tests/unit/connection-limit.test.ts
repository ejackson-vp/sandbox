/**
 * Concurrent request cap.
 *
 * Real listeners and real sockets, because the property under test is slot
 * accounting across an abort and a torn-down response: a fake `res` would only
 * prove that the test can emit `close`.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { MetricsRegistry } from "../../shared/src/metrics.js";
import { createConnectionLimiter, type ConnectionLimiter } from "../../api/src/connection-limit.js";

const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    // A held handler keeps its socket open; close() alone would wait for it.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

interface Reply {
  status: number;
  body: string;
}

/** One request on its own socket: `agent: false` makes concurrency explicit. */
function request(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, agent: false, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Start a request without awaiting the reply; used for held handlers. */
function start(port: number, path: string, headers: Record<string, string> = {}): {
  done: Promise<Reply>;
  abort: () => void;
} {
  let abort!: () => void;
  const done = new Promise<Reply>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, agent: false, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    // Destroying the client socket is a reset, not a failure of the test.
    req.on("error", () => resolve({ status: 0, body: "" }));
    abort = () => req.destroy();
    req.end();
  });
  return { done, abort };
}

function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!check()) throw new Error("condition not met in time");
}

/** Value of one rendered series, 0 when the family has not moved yet. */
function series(registry: MetricsRegistry, name: string): number {
  const line = registry
    .render()
    .split("\n")
    .find((candidate) => candidate.startsWith(`${name} `));
  return line === undefined ? 0 : Number(line.slice(name.length + 1));
}

interface Harness {
  port: number;
  limiter: ConnectionLimiter;
  registry: MetricsRegistry;
  hold: { wait: Promise<void>; release: () => void };
}

async function startApp(opts: {
  maxPerClient: number;
  maxGlobal: number;
  trustProxy?: boolean;
}): Promise<Harness> {
  const registry = new MetricsRegistry({ cacheMs: 0 });
  const limiter = createConnectionLimiter({
    maxPerClient: opts.maxPerClient,
    maxGlobal: opts.maxGlobal,
    registry,
  });
  const hold = gate();
  const app = express();
  // Same setting the server makes from TRUST_PROXY_HOPS: one forwarded hop, so
  // `req.ip` is the client a proxy says it is.
  if (opts.trustProxy) app.set("trust proxy", 1);
  app.use(limiter.middleware);
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/readyz", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/hold", async (_req, res) => {
    await hold.wait;
    res.json({ ok: true });
  });
  app.get("/boom", () => {
    throw new Error("synthetic handler failure");
  });
  app.get("/timeout", (_req, res) => {
    setTimeout(() => res.destroy(), 10);
  });
  // Quiet error handler: Express's default prints the synthetic failure.
  app.use((_err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "internal_error" });
  });
  const port = await listen(http.createServer(app));
  return { port, limiter, registry, hold };
}

describe("concurrent request cap", () => {
  it("never exceeds the per-client cap under concurrency", async () => {
    const { port, limiter, registry, hold } = await startApp({ maxPerClient: 4, maxGlobal: 1_000 });

    const attempts = Array.from({ length: 12 }, () => start(port, "/hold"));
    // All eight refusals are recorded and four slots are held: no fifth slot
    // was handed out while the earlier four were still in flight.
    await waitFor(
      () => series(registry, 'sandbox_connection_limit_total{scope="client"}') === 8,
    );
    expect(limiter.state().inFlight).toBe(4);

    hold.release();
    const replies = await Promise.all(attempts.map((attempt) => attempt.done));
    expect(replies.filter((reply) => reply.status === 200)).toHaveLength(4);
    expect(replies.filter((reply) => reply.status === 429)).toHaveLength(8);
    for (const reply of replies.filter((candidate) => candidate.status === 429)) {
      expect(JSON.parse(reply.body)).toEqual({ error: "connection_limit" });
    }
    await waitFor(() => limiter.state().inFlight === 0);
  });

  it("returns the slot after a successful response", async () => {
    const { port, limiter } = await startApp({ maxPerClient: 1, maxGlobal: 10 });
    for (let i = 0; i < 3; i += 1) {
      expect((await request(port, "/healthz")).status).toBe(200);
      expect((await request(port, "/boom")).status).toBe(500);
      await waitFor(() => limiter.state().inFlight === 0);
    }
  });

  it("returns the slot when the handler fails", async () => {
    const { port, limiter, registry } = await startApp({ maxPerClient: 1, maxGlobal: 10 });
    expect((await request(port, "/boom")).status).toBe(500);
    await waitFor(() => limiter.state().inFlight === 0);
    // The slot came back, so the next request is served rather than refused.
    expect((await request(port, "/healthz")).status).toBe(200);
    expect(series(registry, 'sandbox_connection_limit_total{scope="client"}')).toBe(0);
  });

  it("returns the slot when the client aborts", async () => {
    const { port, limiter, hold } = await startApp({ maxPerClient: 1, maxGlobal: 10 });
    const attempt = start(port, "/hold");
    await waitFor(() => limiter.state().inFlight === 1);
    attempt.abort();
    await waitFor(() => limiter.state().inFlight === 0);
    hold.release();
    expect(limiter.state().inFlight).toBe(0);
    // A new client request is accepted: the aborted one did not leak a slot.
    expect((await request(port, "/healthz")).status).toBe(200);
  });

  it("returns the slot when a response is torn down by a timeout", async () => {
    const { port, limiter } = await startApp({ maxPerClient: 1, maxGlobal: 10 });
    const attempt = start(port, "/timeout");
    await waitFor(() => limiter.state().inFlight === 1);
    await attempt.done;
    await waitFor(() => limiter.state().inFlight === 0);
    expect((await request(port, "/healthz")).status).toBe(200);
  });

  it("exempts health and readiness probes from a saturated client", async () => {
    const { port, limiter, registry, hold } = await startApp({ maxPerClient: 1, maxGlobal: 1 });
    const held = start(port, "/hold");
    await waitFor(() => limiter.state().inFlight === 1);

    // The client is over both caps, and the pod must still look healthy.
    expect(await request(port, "/healthz")).toEqual({ status: 200, body: '{"ok":true}' });
    expect((await request(port, "/readyz")).status).toBe(200);
    // Probes took no slot: the next ordinary request is still refused.
    expect((await request(port, "/boom")).status).toBe(429);
    expect(series(registry, 'sandbox_connection_limit_total{scope="client"}')).toBe(1);

    hold.release();
    await held.done;
    await waitFor(() => limiter.state().inFlight === 0);
  });

  it("keys the per-client cap on req.ip behind a trusted proxy", async () => {
    const { port, limiter, hold } = await startApp({
      maxPerClient: 1,
      maxGlobal: 100,
      trustProxy: true,
    });

    const first = start(port, "/hold", { "x-forwarded-for": "203.0.113.7" });
    const second = start(port, "/hold", { "x-forwarded-for": "203.0.113.8" });
    await waitFor(() => limiter.state().inFlight === 2);
    // Two different clients, one slot each: neither is refused.
    expect(limiter.state().clients).toBe(2);
    // A second request from the first client is over its own cap.
    expect((await request(port, "/hold", { "x-forwarded-for": "203.0.113.7" })).status).toBe(429);

    hold.release();
    const replies = await Promise.all([first.done, second.done]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
  });

  it("bounds the whole process across clients with the global cap", async () => {
    const { port, limiter, registry, hold } = await startApp({
      maxPerClient: 10,
      maxGlobal: 2,
      trustProxy: true,
    });

    const attempts = ["203.0.113.1", "203.0.113.2", "203.0.113.3"].map((client) =>
      start(port, "/hold", { "x-forwarded-for": client }),
    );
    await waitFor(
      () => series(registry, 'sandbox_connection_limit_total{scope="global"}') === 1,
    );
    expect(limiter.state().inFlight).toBe(2);

    hold.release();
    const replies = await Promise.all(attempts.map((attempt) => attempt.done));
    expect(replies.filter((reply) => reply.status === 429)).toHaveLength(1);
  });

  it("can be disabled per client while the global cap still binds", async () => {
    // 0 is the documented off switch for the per-client check.
    const { port, limiter, hold } = await startApp({ maxPerClient: 0, maxGlobal: 1 });
    const held = start(port, "/hold");
    await waitFor(() => limiter.state().inFlight === 1);
    expect((await request(port, "/healthz")).status).toBe(200);
    expect((await request(port, "/boom")).status).toBe(429);
    hold.release();
    await held.done;
    await waitFor(() => limiter.state().inFlight === 0);
  });
});
