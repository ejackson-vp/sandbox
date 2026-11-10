import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricsRegistry } from "../../shared/src/metrics.js";
import { TokenBucket, rateLimit } from "../../shared/src/rate-limit.js";
import { createControlApi } from "../../controller/src/control-api.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import { createRelay, type RelayServer } from "../../controller/src/relay.js";
import { RelayClient } from "../../controller/src/relay-client.js";
import { Store } from "../../controller/src/store.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";

const ADMIN = "rate-limit-admin-token-0123456789";
const RELAY_ADMIN = "r".repeat(24);

const servers: http.Server[] = [];
const relays: RelayServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close().catch(() => undefined);
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "x402-rate-limit-"));
  dirs.push(dir);
  return dir;
}

function listen(app: http.RequestListener): Promise<number> {
  const server = http.createServer(app);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function controllerConfig() {
  return loadControllerConfig({
    ADMIN_TOKEN: ADMIN,
    ROLE: "controller",
    KUBERNETES_ENABLED: "false",
    RELAY_ADMIN_TOKEN: RELAY_ADMIN,
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
    DB_PATH: join(tempDir(), "controller.db"),
  });
}

describe("TokenBucket", () => {
  it("enforces a burst and refills over time", () => {
    let now = 0;
    const bucket = new TokenBucket(1, 1, 16, () => now);
    expect(bucket.take("peer")).toBe(true);
    expect(bucket.take("peer")).toBe(false);
    expect(bucket.retryAfterSeconds("peer")).toBe(1);

    now += 500;
    expect(bucket.take("peer")).toBe(false);
    now += 500;
    expect(bucket.take("peer")).toBe(true);
  });

  it("keeps per-key state bounded under key rotation", () => {
    const bucket = new TokenBucket(1, 0.001, 8, () => 0);
    for (let i = 0; i < 500; i += 1) bucket.take(`peer-${i}`);
    expect(bucket.size()).toBeLessThanOrEqual(8);
    // A fresh key still works; the table is bounded, not wedged.
    expect(bucket.take("fresh")).toBe(true);
    expect(bucket.take("fresh")).toBe(false);
  });

  it("does not reset an exhausted bucket when unrelated keys overflow", () => {
    const bucket = new TokenBucket(1, 0.001, 8, () => 0);
    expect(bucket.take("victim")).toBe(true);
    expect(bucket.take("victim")).toBe(false);
    for (let i = 0; i < 200; i += 1) bucket.take(`attacker-${i}`);
    expect(bucket.take("victim")).toBe(false);
  });
});

describe("internal listener rate limiting", () => {
  it("returns 429 on an over-burst controller wake", async () => {
    let now = 0;
    const store = new Store(join(tempDir(), "controller.db"));
    const app = createControlApi({
      cfg: controllerConfig(),
      store,
      relay: new RelayClient({ baseUrl: "http://127.0.0.1:1", adminToken: RELAY_ADMIN, timeoutMs: 100 }),
      capacity: {} as CapacityService,
      internalRateLimiter: new TokenBucket(1, 1, 16, () => now),
    });
    const port = await listen(app);
    const wake = () =>
      fetch(`http://127.0.0.1:${port}/internal/wake`, {
        method: "POST",
        headers: { "x-internal-token": ADMIN },
      });

    const first = await wake();
    expect(first.status).toBe(202);
    const second = await wake();
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("1");
    expect(await second.json()).toEqual({ error: "rate_limited", scope: "internal" });

    now += 1_000;
    expect((await wake()).status).toBe(202);
    store.close();
  });

  it("records the scope when the shared middleware rejects", () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    const middleware = rateLimit(new TokenBucket(1, 1, 16, () => 0), "internal", registry);
    const next = vi.fn();
    const response = () => {
      const res = {
        statusCode: 0,
        body: undefined as unknown,
        setHeader: vi.fn(),
        status(code: number) {
          res.statusCode = code;
          return { json: (body: unknown) => { res.body = body; return res; } };
        },
      };
      return res;
    };

    middleware({ ip: "10.0.0.1" }, response(), next);
    expect(next).toHaveBeenCalledTimes(1);

    const limited = response();
    middleware({ ip: "10.0.0.1" }, limited, next);
    expect(limited.statusCode).toBe(429);
    expect(limited.body).toEqual({ error: "rate_limited", scope: "internal" });
    expect(registry.render()).toContain('sandbox_rate_limited_total{scope="internal"} 1');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 429 on an over-burst authenticated relay register", async () => {
    let now = 0;
    const registryMetrics = new MetricsRegistry({ cacheMs: 0 });
    const relay = createRelay({
      adminToken: RELAY_ADMIN,
      metricsRegistry: registryMetrics,
      internalRateLimiter: new TokenBucket(1, 1, 16, () => now),
    });
    relays.push(relay);
    await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
    const port = (relay.server.address() as AddressInfo).port;

    const register = (sessionId: string) =>
      fetch(`http://127.0.0.1:${port}/internal/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": RELAY_ADMIN },
        body: JSON.stringify({ sessionId, tokenHash: "t".repeat(64), ttlMs: 60_000 }),
      });

    expect((await register("sbx_rate_limit_1")).status).toBe(201);
    const limited = await register("sbx_rate_limit_2");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited", scope: "relay" });
  });
});
