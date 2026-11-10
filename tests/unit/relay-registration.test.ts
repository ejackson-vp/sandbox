/**
 * Generation-checked relay registration.
 *
 * These use a controllable relay surface rather than a real relay so the
 * restart interleavings are deterministic: the controller must never treat a
 * registration accepted by a relay that is being replaced as success, and it
 * must reach the replacement without waiting for a reconcile tick.
 */
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RelayClient, RelayUnavailableError } from "../../controller/src/relay-client.js";
import { TcpRouter } from "../helpers/tcp-router.js";

const ADMIN = "relay-admin-token-0123456789";

interface FakeRelay {
  port: number;
  generation: string;
  healthy: boolean;
  registrations: string[];
  purges: string[];
  /** Runs before the generation precondition; return true to force a 409. */
  onRegister?: (body: Record<string, unknown>) => boolean;
  setGeneration(generation: string): void;
  setHealthy(healthy: boolean): void;
  close(): Promise<void>;
}

async function startFakeRelay(generation: string): Promise<FakeRelay> {
  const relay: FakeRelay = {
    port: 0,
    generation,
    healthy: true,
    registrations: [],
    purges: [],
    setGeneration(next) {
      relay.generation = next;
    },
    setHealthy(next) {
      relay.healthy = next;
    },
    close: async () => {},
  };

  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/healthz") {
      if (!relay.healthy) return send(503, { error: "not_ready" });
      return send(200, { ok: true, generation: relay.generation, sessions: 0 });
    }
    if (req.method === "POST" && req.url === "/internal/register") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        if (relay.onRegister?.(body)) {
          return send(409, { error: "session_already_connected" });
        }
        if (typeof body.generation === "string" && body.generation !== relay.generation) {
          return send(409, { error: "relay_generation_changed", generation: relay.generation });
        }
        relay.registrations.push(String(body.sessionId));
        return send(201, { ok: true, generation: relay.generation });
      });
      return;
    }
    if (req.method === "DELETE" && req.url?.startsWith("/internal/")) {
      relay.purges.push(decodeURIComponent(req.url.split("/")[2] ?? ""));
      return send(200, { ok: true });
    }
    send(404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  relay.port = (server.address() as net.AddressInfo).port;
  relay.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return relay;
}

const openRelays: FakeRelay[] = [];
const openRouters: TcpRouter[] = [];

afterEach(async () => {
  for (const router of openRouters.splice(0)) await router.close();
  for (const relay of openRelays.splice(0)) await relay.close();
});

async function fakeRelay(generation: string): Promise<FakeRelay> {
  const relay = await startFakeRelay(generation);
  openRelays.push(relay);
  return relay;
}

async function routerTo(port: number): Promise<{ router: TcpRouter; baseUrl: string }> {
  const router = new TcpRouter();
  router.setUpstream(port);
  const routerPort = await router.listen();
  openRouters.push(router);
  return { router, baseUrl: `http://127.0.0.1:${routerPort}` };
}

function client(baseUrl: string): RelayClient {
  return new RelayClient({ baseUrl, adminToken: ADMIN, timeoutMs: 1000 });
}

describe("generation-checked relay registration", () => {
  it("registers on the replacement relay, not a stale pinned connection", async () => {
    const oldRelay = await fakeRelay("generation-a");
    const newRelay = await fakeRelay("generation-b");
    const { router, baseUrl } = await routerTo(oldRelay.port);
    const relay = client(baseUrl);

    const first = await relay.registerCurrent("sbx_restart", "hash", 60_000, { deadlineMs: 2_000 });
    expect(first.generation).toBe("generation-a");
    expect(oldRelay.registrations).toEqual(["sbx_restart"]);

    // The Service now points at the replacement, but the old relay stays alive
    // (a terminating pod) and would still answer an existing socket.
    router.setUpstream(newRelay.port);
    const second = await relay.registerCurrent("sbx_restart", "hash", 60_000, { deadlineMs: 2_000 });

    expect(second.generation).toBe("generation-b");
    expect(newRelay.registrations).toEqual(["sbx_restart"]);
    expect(oldRelay.registrations).toEqual(["sbx_restart"]);
  });

  it("retries when the generation changes between the probe and the register", async () => {
    const relay = await fakeRelay("generation-a");
    const { baseUrl } = await routerTo(relay.port);
    let flips = 0;
    relay.onRegister = () => {
      // Only the first attempt is disturbed. The relay answers /healthz with A,
      // then restarts before the register lands.
      if (flips === 0) {
        flips += 1;
        relay.setGeneration("generation-b");
      }
      return false;
    };

    const result = await client(baseUrl).registerCurrent("sbx_flip", "hash", 60_000, {
      deadlineMs: 2_000,
    });
    expect(result.generation).toBe("generation-b");
    expect(result.attempts).toBeGreaterThanOrEqual(2);
    expect(relay.registrations).toEqual(["sbx_flip"]);
  });

  it("replaces a stale connected entry for a resumed session", async () => {
    const relay = await fakeRelay("generation-a");
    const { baseUrl } = await routerTo(relay.port);
    let conflicts = 1;
    relay.onRegister = () => {
      if (conflicts > 0) {
        conflicts -= 1;
        return true;
      }
      return false;
    };

    const result = await client(baseUrl).registerCurrent("sbx_resume", "hash", 60_000, {
      deadlineMs: 2_000,
      replaceConnected: true,
    });
    expect(result.generation).toBe("generation-a");
    expect(relay.purges).toEqual(["sbx_resume"]);
    expect(relay.registrations).toEqual(["sbx_resume"]);
  });

  it("gives up after the registration deadline while the relay is unavailable", async () => {
    const relay = await fakeRelay("generation-a");
    relay.setHealthy(false);
    const { baseUrl } = await routerTo(relay.port);

    await expect(
      client(baseUrl).registerCurrent("sbx_down", "hash", 60_000, { deadlineMs: 300 }),
    ).rejects.toBeInstanceOf(RelayUnavailableError);
    expect(relay.registrations).toEqual([]);
  });
});

describe("relay readiness gate", () => {
  it("reports not-ready while the relay is unreachable and ready once it returns", async () => {
    const relay = await fakeRelay("generation-a");
    const { baseUrl } = await routerTo(relay.port);
    const relayClient = client(baseUrl);
    expect(await relayClient.isReady()).toBe(true);

    relay.setHealthy(false);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await relayClient.isReady()).toBe(false);

    relay.setHealthy(true);
    expect(await relayClient.isReady()).toBe(true);
    expect(relayClient.readyGeneration()).toBe("generation-a");
  });
});
