/**
 * Liveness vs readiness.
 *
 * Liveness must keep answering when a dependency is broken (so Kubernetes does
 * not restart a live single-writer controller), while readiness must turn 503
 * and name the component that cannot serve. Dependency results are cached
 * briefly so kubelet probes do not hammer the store, relay or Kubernetes API.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createControlApi } from "../../controller/src/control-api.js";
import type { Leadership } from "../../controller/src/leadership.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import { createRelay, type RelayServer } from "../../controller/src/relay.js";
import { RelayClient } from "../../controller/src/relay-client.js";
import { NullProvisioner } from "../../controller/src/k8s-null.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import { SoloLeadership } from "../../controller/src/leadership.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import { freshStore, testDatabaseUrl } from "../helpers/test-store.js";

const ADMIN = "readiness-admin-token-0123456789";
const RELAY_ADMIN = "r".repeat(24);

const servers: http.Server[] = [];
const relays: RelayServer[] = [];

afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close().catch(() => undefined);
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function listen(app: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function controllerConfig() {
  return loadControllerConfig({
    ADMIN_TOKEN: ADMIN,
    ROLE: "controller",
    KUBERNETES_ENABLED: "false",
    RELAY_ADMIN_TOKEN: RELAY_ADMIN,
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
    DATABASE_URL: testDatabaseUrl(),
  });
}

interface Harness {
  store: PostgresStore;
  base: string;
  provisioner: Provisioner;
  closeStore(): Promise<void>;
}

async function startController(
  opts: {
    relayUrl?: string;
    provisioner?: Provisioner;
    leadership?: Pick<Leadership, "isLeader" | "onChange">;
  } = {},
): Promise<Harness> {
  const store = await freshStore();
  let relayUrl = opts.relayUrl;
  if (!relayUrl) {
    const relay = createRelay({ adminToken: RELAY_ADMIN });
    relays.push(relay);
    await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
    relayUrl = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
  }
  const relay = new RelayClient({ baseUrl: relayUrl, adminToken: RELAY_ADMIN, timeoutMs: 500 });
  const provisioner = opts.provisioner ?? new NullProvisioner();
  const app = createControlApi({
    cfg: controllerConfig(),
    store,
    relay,
    provisioner,
    ...(opts.leadership ? { leadership: opts.leadership } : {}),
    // These tests never reach the capacity routes.
    capacity: {} as CapacityService,
  });
  const { port } = await listen(app);
  return {
    store,
    base: `http://127.0.0.1:${port}`,
    provisioner,
    closeStore: () => store.close(),
  };
}

async function get(base: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("controller readiness", () => {
  it("reports every dependency Ready and leaves liveness trivial", async () => {
    const harness = await startController();
    const readiness = await get(harness.base, "/internal/readyz");
    expect(readiness.status).toBe(200);
    expect(readiness.body).toMatchObject({
      ok: true,
      cached: false,
      components: { store: { ok: true }, relay: { ok: true }, provisioner: { ok: true } },
    });

    // Liveness is independent of dependency health.
    const live = await get(harness.base, "/internal/healthz");
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ ok: true });
  });

  it("reports a leadership standby not ready and follows the handover immediately", async () => {
    const leadership = new SoloLeadership("controller-0");
    const harness = await startController({ leadership });
    await leadership.start();

    const leader = await get(harness.base, "/internal/readyz");
    expect(leader.status).toBe(200);
    expect(leader.body).toMatchObject({ ok: true, components: { leadership: { ok: true } } });

    // The Service routes on readiness, so a stale 200 would keep this replica in
    // rotation after it stopped being the writer. The cache is invalidated on
    // the transition, which is what makes this assertion pass without waiting.
    await leadership.stop();
    await harness.store.setWritesBlocked(true);
    const standby = await get(harness.base, "/internal/readyz");
    expect(standby.status).toBe(503);
    expect(standby.body).toMatchObject({
      ok: false,
      components: {
        leadership: { ok: false, reason: "not_leader" },
        store: { ok: false, reason: "read_only" },
      },
    });
  });

  it("returns 503 naming the store when the database is closed, but liveness stays up", async () => {
    const harness = await startController();
    await harness.closeStore();

    const readiness = await get(harness.base, "/internal/readyz");
    expect(readiness.status).toBe(503);
    expect(readiness.body).toMatchObject({
      ok: false,
      components: { store: { ok: false, reason: "closed" }, relay: { ok: true } },
    });

    const live = await get(harness.base, "/internal/healthz");
    expect(live.status).toBe(200);
  });

  it("returns 503 naming the relay when it is unreachable", async () => {
    const port = await closedPort();
    const harness = await startController({ relayUrl: `http://127.0.0.1:${port}` });

    const readiness = await get(harness.base, "/internal/readyz");
    expect(readiness.status).toBe(503);
    expect(readiness.body).toMatchObject({
      ok: false,
      components: { store: { ok: true }, relay: { ok: false, reason: "unreachable" } },
    });
  });

  it("returns 503 naming the provisioner when it cannot reach its backend", async () => {
    const provisioner = {
      healthCheck: async () => {
        throw new Error("kubernetes api is down");
      },
    } as unknown as Provisioner;
    const harness = await startController({ provisioner });

    const readiness = await get(harness.base, "/internal/readyz");
    expect(readiness.status).toBe(503);
    expect(readiness.body).toMatchObject({
      ok: false,
      components: { provisioner: { ok: false, reason: "unreachable" } },
    });
  });

  it("does not leak the dependency error message", async () => {
    const provisioner = {
      healthCheck: async () => {
        throw new Error("https://admin:secret@kube.internal/namespaces/sandbox");
      },
    } as unknown as Provisioner;
    const harness = await startController({ provisioner });

    const readiness = await get(harness.base, "/internal/readyz");
    expect(JSON.stringify(readiness.body)).not.toContain("secret");
    expect(JSON.stringify(readiness.body)).not.toContain("kube.internal");
  });
});
