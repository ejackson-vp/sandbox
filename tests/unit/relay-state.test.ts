/**
 * The fault harness reads recovery's pending count from the relay's private
 * metrics listener, not from the mTLS-only /internal routes. These tests pin
 * the metric name, the exposition parse and the HTTP path without a cluster.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { WebSocket } from "ws";
import { MetricsRegistry, startMetricsServer } from "../../shared/src/entries/runtime.js";
import { RelayRegistry } from "../../controller/src/relay/registry.js";
import { collectRelayMetrics } from "../../controller/src/relay/metrics.js";
import {
  parseActiveGauge,
  parsePendingGauge,
  readRelayActive,
  readRelayPending,
  RELAY_ACTIVE_GAUGE,
  RELAY_PENDING_GAUGE,
} from "../../scripts/relay-state.js";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function serve(registry: MetricsRegistry): Promise<string> {
  server = await startMetricsServer({ port: 0, host: "127.0.0.1", registry });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("relay pending gauge", () => {
  it("reads the label-less gauge from the relay metrics exposition", async () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    registry.gauge(RELAY_PENDING_GAUGE, "Requests awaiting a guest response").set({}, 2);
    // A lookalike must not be mistaken for the gauge.
    registry.counter(`${RELAY_PENDING_GAUGE}_total`, "lookalike").inc({}, 9);

    expect(await readRelayPending(await serve(registry))).toBe(2);
  });

  it("returns null while the gauge is absent so the caller retries", async () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    registry.counter(`${RELAY_PENDING_GAUGE}_total`, "lookalike").inc({}, 9);

    expect(await readRelayPending(await serve(registry))).toBeNull();
  });

  it("reflects the real relay registry's pending total at scrape time", async () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    const sessions = new RelayRegistry({ maxSessions: 1, responseTtlMs: 60_000, metricsRegistry: registry });
    const sessionId = "sbx_relay_state_probe";
    sessions.register(sessionId, "hash", 60_000);
    const socket = { readyState: 1, send: () => undefined, terminate: () => undefined } as unknown as WebSocket;
    sessions.attach(sessionId, socket);
    sessions.request(sessionId, "request-state-probe", "e30=", Date.now() + 60_000, 1);
    expect(sessions.pendingTotal()).toBe(1);

    server = await startMetricsServer({
      port: 0,
      host: "127.0.0.1",
      registry,
      onScrape: () => collectRelayMetrics(registry, sessions),
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await readRelayPending(base)).toBe(1);
  });

  it("parses a real exposition line and ignores comments and lookalikes", () => {
    const body = [
      "# HELP sandbox_relay_pending_requests Requests awaiting a guest response",
      "# TYPE sandbox_relay_pending_requests gauge",
      "sandbox_relay_pending_requests 0",
      "sandbox_relay_pending_requests_total 4",
      "",
    ].join("\n");
    expect(parsePendingGauge(body)).toBe(0);

    expect(parsePendingGauge("# TYPE x gauge\nother_metric 1\n")).toBeNull();
    expect(parsePendingGauge(`${RELAY_PENDING_GAUGE} not-a-number\n`)).toBeNull();
    expect(parsePendingGauge("")).toBeNull();
    expect(parsePendingGauge(`${RELAY_PENDING_GAUGE} 3\n`)).toBe(3);
  });

  it("returns null for an unreachable or wrong listener", async () => {
    expect(await readRelayPending("http://127.0.0.1:1")).toBeNull();
    expect(await readRelayActive("http://127.0.0.1:1")).toBeNull();
  });
});

describe("relay active gauge", () => {
  it("reflects guest-reported active operations, not controller gates", async () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    const sessions = new RelayRegistry({ maxSessions: 1, responseTtlMs: 60_000, metricsRegistry: registry });
    const sessionId = "sbx_relay_active_probe";
    sessions.register(sessionId, "hash", 60_000);
    const socket = { readyState: 1, send: () => undefined, terminate: () => undefined } as unknown as WebSocket;
    sessions.attach(sessionId, socket);
    sessions.request(sessionId, "request-active-probe", "e30=", Date.now() + 60_000, 1);

    server = await startMetricsServer({
      port: 0,
      host: "127.0.0.1",
      registry,
      onScrape: () => collectRelayMetrics(registry, sessions),
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The controller has a frame pending, but the guest has not reported it.
    expect(await readRelayPending(base)).toBe(1);
    expect(await readRelayActive(base)).toBe(0);

    expect(sessions.status(sessionId, "request-active-probe", 1)).toBe("ok");
    expect(await readRelayActive(base)).toBe(1);
    expect(sessions.activeTotal()).toBe(1);

    expect(sessions.status(sessionId, "", 1)).toBe("ok");
    expect(await readRelayActive(base)).toBe(0);
  });

  it("parses the active gauge and rejects lookalikes", () => {
    const body = [
      `# TYPE ${RELAY_ACTIVE_GAUGE} gauge`,
      `${RELAY_ACTIVE_GAUGE} 4`,
      `${RELAY_ACTIVE_GAUGE}_total 9`,
      "",
    ].join("\n");
    expect(parseActiveGauge(body)).toBe(4);
    expect(parseActiveGauge("# TYPE x gauge\nother_metric 1\n")).toBeNull();
    expect(parseActiveGauge("")).toBeNull();
  });
});

describe("relay epoch reset outcome", () => {
  // Which branch of resetConnection ran. A `terminate` result is a close ordered
  // after the queued frame, so the withdrawn frame can still be read; recording
  // it is the difference between the documented race and a bug (#128).
  function resetCounts(registry: MetricsRegistry): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const line of registry.render().split("\n")) {
      const match = /^sandbox_relay_connection_resets_total\{mode="([^"]+)"\} (\d+)$/.exec(line);
      if (match) counts[match[1]!] = Number(match[2]);
    }
    return counts;
  }

  function withdrawOneFrame(sessionId: string, socket: { resetAndDestroy?: () => void } | undefined) {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    const sessions = new RelayRegistry({ maxSessions: 1, responseTtlMs: 60_000, metricsRegistry: registry });
    sessions.register(sessionId, "hash", 60_000);
    let terminated = false;
    const ws = {
      readyState: 1,
      send: () => undefined,
      terminate: () => {
        terminated = true;
      },
    } as unknown as WebSocket;
    sessions.attach(sessionId, ws, socket);
    // The guest is behind the recovery epoch and has no command running, the
    // only condition that ends the link.
    sessions.status(sessionId, "", 1);
    sessions.request(sessionId, `request-${sessionId}`, "e30=", Date.now() + 60_000, 1);
    const raised = sessions.raiseEpoch(sessionId, 2);
    return { registry, raised, terminated };
  }

  it("counts a TCP reset when the upgrade socket was captured", () => {
    let reset = false;
    const { registry, raised, terminated } = withdrawOneFrame("sbx_reset_branch_tcp", {
      resetAndDestroy: () => {
        reset = true;
      },
    });
    expect(raised).toEqual({ result: "ok", withdrawn: 1, reset: true });
    expect(reset).toBe(true);
    expect(terminated).toBe(false);
    expect(resetCounts(registry)).toEqual({ tcp_reset: 1 });
  });

  it("counts and warns on the terminate fallback when it was not", () => {
    const { registry, raised, terminated } = withdrawOneFrame("sbx_reset_branch_terminate", undefined);
    expect(raised).toEqual({ result: "ok", withdrawn: 1, reset: true });
    // The link still ends, but as a close: the queued frame is not discarded.
    expect(terminated).toBe(true);
    expect(resetCounts(registry)).toEqual({ terminate: 1 });
  });
});
