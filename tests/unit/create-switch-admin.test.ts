/**
 * The create kill switch's admin routes (schema v21).
 *
 * Auth is the existing admin token: there is no second credential for the
 * emergency stop, and a route that refuses creates for everyone must not be
 * reachable without the same proof as the ledger and allowlist routes.
 *
 * The answer is the effective state, so an operator sees the flag, the expiry
 * and the reason they typed in the same round trip. A past `--until` is a 400
 * and writes nothing: a row that says "on" and behaves off cannot be explained by
 * `status`.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createControlApi } from "../../controller/src/control-api.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import { RelayClient } from "../../controller/src/relay-client.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import { freshStore, testDatabaseUrl } from "../helpers/test-store.js";

const ADMIN = "create-switch-admin-token-0123456789";
const REASON = "payments: facilitator double-settling (INC-431)";
const ACTOR = "eric";

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
    ALLOW_INSECURE_DEV: "true",
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
  init: RequestInit & { token?: string | null } = {},
): Promise<Response> {
  const { token = ADMIN, ...rest } = init;
  return fetch(`${url}/internal/create-switch`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { "x-internal-token": token }),
      ...(rest.headers ?? {}),
    },
  });
}

interface SwitchAnswer {
  switch: {
    enabled: boolean;
    reason: string;
    actor: string;
    changedAt: number | null;
    expiresAt: number | null;
    expired: boolean;
  };
}

describe("create switch admin routes", () => {
  it("requires the admin token on every route", async () => {
    const { url, store } = await start();

    expect((await send(url, { method: "GET", token: null })).status).toBe(401);
    expect(
      (
        await send(url, {
          method: "PUT",
          body: JSON.stringify({ reason: REASON, actor: ACTOR, until: null }),
          token: null,
        })
      ).status,
    ).toBe(401);
    expect(
      (await send(url, { method: "DELETE", body: JSON.stringify({ actor: ACTOR }), token: null }))
        .status,
    ).toBe(401);

    // Nothing was flipped by the refused calls.
    await expect(store.readCreateSwitch(Date.now())).resolves.toMatchObject({ enabled: false });
  });

  it("reports, enables and disables, and the row is what the API reads", async () => {
    const { url, store } = await start();

    const initial = (await (await send(url)).json()) as SwitchAnswer;
    expect(initial.switch).toMatchObject({ enabled: false, changedAt: null, reason: "" });

    const until = new Date(Date.now() + 3_600_000).toISOString();
    const enabled = await send(url, {
      method: "PUT",
      body: JSON.stringify({ reason: REASON, actor: ACTOR, until }),
    });
    expect(enabled.status).toBe(200);
    const on = (await enabled.json()) as SwitchAnswer;
    expect(on.switch).toMatchObject({
      enabled: true,
      reason: REASON,
      actor: ACTOR,
      expiresAt: Date.parse(until),
      expired: false,
    });
    // The controller's own read is the same answer the API will get: one row.
    await expect(store.readCreateSwitch(Date.now())).resolves.toMatchObject({
      enabled: true,
      reason: REASON,
      actor: ACTOR,
    });

    const disabled = await send(url, {
      method: "DELETE",
      body: JSON.stringify({ actor: "duty" }),
    });
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as SwitchAnswer).switch).toMatchObject({
      enabled: false,
      actor: "duty",
      expired: false,
    });
    await expect(store.readCreateSwitch(Date.now())).resolves.toMatchObject({ enabled: false });
  });

  it("refuses a past --until and leaves the switch as it was", async () => {
    const { url, store } = await start();

    const res = await send(url, {
      method: "PUT",
      body: JSON.stringify({
        reason: REASON,
        actor: ACTOR,
        until: new Date(Date.now() - 1_000).toISOString(),
      }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("until_in_past");
    await expect(store.readCreateSwitch(Date.now())).resolves.toMatchObject({ enabled: false });
  });

  it("refuses a malformed body rather than guessing the actor or reason", async () => {
    const { url, store } = await start();

    expect(
      (
        await send(url, {
          method: "PUT",
          body: JSON.stringify({ reason: REASON, actor: "", until: null }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(url, {
          method: "PUT",
          body: JSON.stringify({ reason: "", actor: ACTOR, until: null }),
        })
      ).status,
    ).toBe(400);
    expect(
      (await send(url, { method: "DELETE", body: JSON.stringify({}) })).status,
    ).toBe(400);
    await expect(store.readCreateSwitch(Date.now())).resolves.toMatchObject({ enabled: false });
  });
});
