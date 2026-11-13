/**
 * The allowlist admin routes (ADR 0013).
 *
 * Auth is the existing admin token; there is no second credential. Disabling an
 * entry must take effect on the next authorize: the decision reads the row every
 * time, so there is no cache to expire.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createControlApi } from "../../controller/src/control-api.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import { RelayClient } from "../../controller/src/relay-client.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import { freshStore, testDatabaseUrl } from "../helpers/test-store.js";

const ADMIN = "allowlist-admin-token-0123456789";
const ADDRESS = "0x1111111111111111111111111111111111111111";

const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function start(): Promise<{ url: string; store: Awaited<ReturnType<typeof freshStore>> }> {
  const store = await freshStore();
  const cfg = loadControllerConfig({
    ADMIN_TOKEN: ADMIN,
    ROLE: "controller",
    KUBERNETES_ENABLED: "false",
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
    DATABASE_URL: testDatabaseUrl(),
  });
  const app = createControlApi({
    cfg,
    store,
    relay: new RelayClient({ baseUrl: "http://127.0.0.1:1", adminToken: "r".repeat(24), timeoutMs: 100 }),
    capacity: {} as CapacityService,
  });
  const server = http.createServer(app);
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  return { url: `http://127.0.0.1:${port}`, store };
}

function send(
  url: string,
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<Response> {
  const { token = ADMIN, ...rest } = init;
  return fetch(`${url}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { "x-internal-token": token }),
      ...(rest.headers ?? {}),
    },
  });
}

const ENTRY = { address: ADDRESS, label: "owner-agent", maxTier: "long", maxConcurrent: 2 };

describe("allowlist admin routes", () => {
  it("requires the admin token on every route", async () => {
    const { url } = await start();

    expect((await send(url, "/internal/payer-allowlist", { token: null })).status).toBe(401);
    expect(
      (
        await send(url, "/internal/payer-allowlist", {
          method: "PUT",
          body: JSON.stringify(ENTRY),
          token: null,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await send(url, `/internal/payer-allowlist/${ADDRESS}`, {
          method: "DELETE",
          token: null,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await send(url, "/internal/payer-allowlist/authorize", {
          method: "POST",
          body: JSON.stringify({ address: ADDRESS, tier: "short" }),
          token: null,
        })
      ).status,
    ).toBe(401);
  });

  it("adds, lists and authorizes an entry", async () => {
    const { url } = await start();

    const added = await send(url, "/internal/payer-allowlist", {
      method: "PUT",
      body: JSON.stringify(ENTRY),
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ entry: { address: ADDRESS, label: "owner-agent" } });

    const listed = await send(url, "/internal/payer-allowlist");
    expect(await listed.json()).toMatchObject({ entries: [{ address: ADDRESS }] });

    const authorized = await send(url, "/internal/payer-allowlist/authorize", {
      method: "POST",
      body: JSON.stringify({ address: ADDRESS, tier: "standard" }),
    });
    expect(await authorized.json()).toMatchObject({
      allowed: true,
      label: "owner-agent",
      maxTier: "long",
    });
  });

  it("disables an entry immediately", async () => {
    const { url } = await start();
    await send(url, "/internal/payer-allowlist", { method: "PUT", body: JSON.stringify(ENTRY) });

    const disabled = await send(url, `/internal/payer-allowlist/${ADDRESS}`, { method: "DELETE" });
    expect(await disabled.json()).toMatchObject({ ok: true, changed: true });

    const authorized = await send(url, "/internal/payer-allowlist/authorize", {
      method: "POST",
      body: JSON.stringify({ address: ADDRESS, tier: "short" }),
    });
    expect(await authorized.json()).toEqual({ allowed: false, reason: "disabled" });

    // Disabling twice is a no-op, not an error.
    const again = await send(url, `/internal/payer-allowlist/${ADDRESS}`, { method: "DELETE" });
    expect(await again.json()).toMatchObject({ ok: true, changed: false });
  });

  it("re-enables through add without losing the address", async () => {
    const { url } = await start();
    await send(url, "/internal/payer-allowlist", { method: "PUT", body: JSON.stringify(ENTRY) });
    await send(url, `/internal/payer-allowlist/${ADDRESS}`, { method: "DELETE" });
    await send(url, "/internal/payer-allowlist", { method: "PUT", body: JSON.stringify(ENTRY) });

    const authorized = await send(url, "/internal/payer-allowlist/authorize", {
      method: "POST",
      body: JSON.stringify({ address: ADDRESS, tier: "short" }),
    });
    expect(await authorized.json()).toMatchObject({ allowed: true });
  });

  it("rejects a malformed address", async () => {
    const { url } = await start();

    const deleted = await send(url, "/internal/payer-allowlist/0x1234", { method: "DELETE" });
    expect(deleted.status).toBe(400);
    expect(await deleted.json()).toEqual({ error: "invalid_address" });

    const added = await send(url, "/internal/payer-allowlist", {
      method: "PUT",
      body: JSON.stringify({ ...ENTRY, address: "0xnot-an-address" }),
    });
    expect(added.status).toBe(400);
  });

  it("rejects an unrankable tier and an out-of-range ceiling", async () => {
    const { url } = await start();

    const tier = await send(url, "/internal/payer-allowlist", {
      method: "PUT",
      body: JSON.stringify({ ...ENTRY, maxTier: "custom" }),
    });
    expect(tier.status).toBe(400);

    const ceiling = await send(url, "/internal/payer-allowlist", {
      method: "PUT",
      body: JSON.stringify({ ...ENTRY, maxConcurrent: 101 }),
    });
    expect(ceiling.status).toBe(400);

    const label = await send(url, "/internal/payer-allowlist", {
      method: "PUT",
      body: JSON.stringify({ ...ENTRY, label: "" }),
    });
    expect(label.status).toBe(400);
  });

  it("returns not_allowlisted for an address that was never added", async () => {
    const { url } = await start();
    const response = await send(url, "/internal/payer-allowlist/authorize", {
      method: "POST",
      body: JSON.stringify({ address: ADDRESS, tier: "short" }),
    });
    expect(await response.json()).toEqual({ allowed: false, reason: "not_allowlisted" });
  });
});
