/**
 * Admin token rotation (#61).
 *
 * The controller accepts the current admin token plus, during an overlap, the
 * previous one. That is what lets the API and any in-cluster tooling switch
 * tokens without a window where one side of the rollout gets 401s. This file
 * pins the accept set and the config guards that keep the two values distinct.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createControlApi } from "../../controller/src/control-api.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import { RelayClient } from "../../controller/src/relay-client.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import { freshStore, testDatabaseUrl } from "../helpers/test-store.js";

const CURRENT = "current-admin-token-0123456789";
const PREVIOUS = "previous-admin-token-0123456789";
const RELAY_ADMIN = "r".repeat(24);

const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function config(extra: Record<string, string> = {}) {
  return loadControllerConfig({
    ADMIN_TOKEN: CURRENT,
    ROLE: "controller",
    KUBERNETES_ENABLED: "false",
    RELAY_ADMIN_TOKEN: RELAY_ADMIN,
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
    DATABASE_URL: testDatabaseUrl(),
    ...extra,
  });
}

async function wakeStatus(cfg: ReturnType<typeof config>, token: string): Promise<number> {
  const store = await freshStore();
  const app = createControlApi({
    cfg,
    store,
    relay: new RelayClient({ baseUrl: "http://127.0.0.1:1", adminToken: RELAY_ADMIN, timeoutMs: 100 }),
    capacity: {} as CapacityService,
  });
  const server = http.createServer(app);
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  const res = await fetch(`http://127.0.0.1:${port}/internal/wake`, {
    method: "POST",
    headers: { "x-internal-token": token },
  });
  return res.status;
}

describe("admin token accept set", () => {
  it("accepts both tokens during the overlap", async () => {
    const cfg = config({ ADMIN_TOKEN_PREVIOUS: PREVIOUS });
    expect(await wakeStatus(cfg, CURRENT)).toBe(202);
    expect(await wakeStatus(cfg, PREVIOUS)).toBe(202);
  });

  it("rejects the previous token once it is retired", async () => {
    const cfg = config();
    expect(await wakeStatus(cfg, CURRENT)).toBe(202);
    expect(await wakeStatus(cfg, PREVIOUS)).toBe(401);
  });

  it("still rejects a token in neither slot", async () => {
    expect(await wakeStatus(config({ ADMIN_TOKEN_PREVIOUS: PREVIOUS }), "x".repeat(32))).toBe(401);
  });
});

describe("admin token rotation config", () => {
  it("carries the previous token and nothing else", () => {
    const cfg = config({ ADMIN_TOKEN_PREVIOUS: PREVIOUS });
    expect(cfg.adminToken).toBe(CURRENT);
    expect(cfg.adminTokenPrevious).toBe(PREVIOUS);
    expect(config().adminTokenPrevious).toBeUndefined();
  });

  it("refuses to rotate to the same value", () => {
    expect(() => config({ ADMIN_TOKEN_PREVIOUS: CURRENT })).toThrow(/must differ/);
  });

  it("refuses a short previous token", () => {
    expect(() => config({ ADMIN_TOKEN_PREVIOUS: "short" })).toThrow(/at least 16/);
  });

  it("refuses a previous token reused by another role", () => {
    expect(() => config({ ADMIN_TOKEN_PREVIOUS: RELAY_ADMIN })).toThrow(/key separation/);
  });
});
