/**
 * The two process entrypoints, booted in this process.
 *
 * `api/src/main.ts` and `controller/src/main.ts` are the wiring that decides
 * whether a deployment starts at all, and they were the highest uncovered
 * lines in the repo. A `spawn` of `node api/dist/main.js` would cover none of
 * it: v8 collects coverage per process, so the child's work lands in a report
 * nobody merges. Both files therefore expose `start()`, which is the old
 * `main()` body returning a handle instead of exiting, and keep `main()` for
 * the signals and exit codes the container relies on.
 *
 * What a failure means: a green run says the API reached its facilitator and
 * bound its public and scrape listeners, the controller opened Postgres,
 * became the writer, started the relay and answered readiness, and both closed
 * every listener when asked. A red one is a deployment that would not come up,
 * or would not come down, and the failing assertion names which step.
 *
 * The signal handlers and the `process.exit` codes are deliberately not
 * exercised: emitting a signal in-process ends the runner, and those paths are
 * the only part of the files that cannot be observed without one. The
 * 503 relay-unreachable shape is covered with a stub in
 * tests/unit/readiness.test.ts; here the controller runs with
 * `RELAY_ENABLED=true` so readiness has a real relay to reach, and the
 * standalone relay and proxy roles get their own boot so every early-return
 * branch of the controller entrypoint runs. Only the mTLS listener variant is
 * left to tests/integration/relay-mtls.test.ts.
 *
 * Both listeners share one metrics registry, because both files run in one
 * process against one `@x402s/shared/runtime`. The scrape assertion is about
 * each port being bound and rendering the build stamp, not about per-process
 * accounting.
 *
 * Ports are the 18_6xx block plus `testPort`, and the database is this file's
 * own namespace, so a leftover run cannot collide with the api-* harness.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMockFacilitator,
  type MockFacilitatorHandle,
} from "../../api/src/mock-facilitator.js";
import { start as startApiProcess, type ApiProcess } from "../../api/src/main.js";
import {
  start as startControllerProcess,
  type ControllerProcess,
} from "../../controller/src/main.js";
import type { ReadinessReport } from "../../shared/src/entries/protocol.js";
import { ensureTestDatabase, testDatabaseUrl } from "../helpers/test-store.js";
import { testPort } from "./ports.js";

const NAMESPACE = "integration-process-boot";

// Four distinct services, four distinct secrets: the controller refuses a
// service token that reuses ADMIN_TOKEN, and the API refuses a capability
// secret that matches its controller token.
const ADMIN = "process-boot-admin-token-0123456789";
const RELAY_ADMIN = "process-boot-relay-admin-token-0123456789";
const WAKE = "process-boot-wake-token-0123456789";
const PROXY_SECRET = "process-boot-proxy-token-secret-0123456789";
const CAPABILITY = "process-boot-capability-secret-0123456789";

const facilitatorPort = testPort(18_600);
const controllerPort = testPort(18_601);
const relayPort = testPort(18_602);
const apiPort = testPort(18_603);
const controllerMetricsPort = testPort(18_604);
const apiMetricsPort = testPort(18_605);
const relayControlPort = testPort(18_606);
const proxyPort = testPort(18_607);
const relayRolePort = testPort(18_608);
const proxyRolePort = testPort(18_609);

const facilitatorUrl = `http://127.0.0.1:${facilitatorPort}`;
const controllerUrl = `http://127.0.0.1:${controllerPort}`;
const relayUrl = `http://127.0.0.1:${relayPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const proxyUrl = `http://127.0.0.1:${proxyPort}`;
const controllerMetricsUrl = `http://127.0.0.1:${controllerMetricsPort}`;
const apiMetricsUrl = `http://127.0.0.1:${apiMetricsPort}`;

/**
 * The environment as this file found it. Restored after each boot: both
 * loaders read `process.env` at call time, and a leaked DATABASE_URL would
 * point the next file's fixtures at this file's database.
 */
const savedEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Probe<T> {
  value: T;
  error?: unknown;
}

/** Poll until `accept` holds, or fail with the last value and error seen. */
async function waitFor<T>(
  label: string,
  probe: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: Probe<T> | undefined;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      last = { value };
      if (accept(value)) return value;
    } catch (error) {
      last = { value: undefined as T, error };
    }
    await sleep(100);
  }
  const detail =
    last?.error !== undefined
      ? `last error ${(last.error as Error).message}`
      : `last value ${JSON.stringify(last?.value)}`;
  throw new Error(`${label} did not settle within ${timeoutMs}ms (${detail})`);
}

/** A GET that resolves to status and parsed body, so a 503 body is readable. */
async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as T };
}

/**
 * True only for a refusal, not a timeout: a listener still bound but silent
 * must fail this, or "closed" would pass against a hung process.
 */
async function connectionRefused(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return false;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code === "ECONNREFUSED" || cause?.code === "ECONNRESET";
  }
}

let facilitator: MockFacilitatorHandle | undefined;
let facilitatorServer: http.Server | undefined;
let controller: ControllerProcess | undefined;
let api: ApiProcess | undefined;

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startFacilitator(): Promise<void> {
  facilitator = await createMockFacilitator();
  facilitatorServer = http.createServer(facilitator.app);
  await listen(facilitatorServer, facilitatorPort);
}

async function startController(): Promise<ControllerProcess> {
  const databaseUrl = testDatabaseUrl(NAMESPACE);
  await ensureTestDatabase(NAMESPACE);
  // The provisioner choice is made from the process environment, not from
  // controller config: a GUEST_BINARY in the suite's environment would select
  // LocalProvisioner and this test would spawn real guests instead of the null
  // provisioner a Kubernetes-disabled controller uses.
  delete process.env.GUEST_BINARY;
  Object.assign(process.env, {
    ROLE: "controller",
    KUBERNETES_ENABLED: "false",
    DATABASE_URL: databaseUrl,
    ADMIN_TOKEN: ADMIN,
    RELAY_ADMIN_TOKEN: RELAY_ADMIN,
    WAKE_TOKEN: WAKE,
    PROXY_TOKEN_SECRET: PROXY_SECRET,
    // Shadows CONTROLLER_PORT, which is what the deployment manifests set.
    X402_CONTROLLER_PORT: String(controllerPort),
    CONTROLLER_URL: controllerUrl,
    // One process, all the data plane: this is what gives /internal/readyz a
    // relay to reach and exercises the relay's listener from a controller role.
    RELAY_ENABLED: "true",
    RELAY_URL: relayUrl,
    RELAY_PORT: String(relayPort),
    RELAY_CONTROL_PORT: String(relayControlPort),
    // The co-located egress proxy, as ROLE=all runs it. The standalone role
    // tests below boot the early-return branches instead.
    PROXY_ENABLED: "true",
    PROXY_PORT: String(proxyPort),
    METRICS_PORT: String(controllerMetricsPort),
  });
  try {
    return await startControllerProcess();
  } finally {
    restoreEnv();
  }
}

async function startApi(): Promise<ApiProcess> {
  Object.assign(process.env, {
    PORT: String(apiPort),
    METRICS_PORT: String(apiMetricsPort),
    PAYMENT_MODE: "mock",
    FACILITATOR_URL: facilitatorUrl,
    CONTROLLER_URL: controllerUrl,
    CONTROLLER_ADMIN_TOKEN: ADMIN,
    CAPABILITY_SECRET: CAPABILITY,
    PUBLIC_BASE_URL: apiUrl,
    // The default is 60 s, longer than the test timeout; a facilitator that
    // does not answer should fail as a boot error, not as a killed test.
    FACILITATOR_INIT_TIMEOUT_MS: "15000",
  });
  try {
    return await startApiProcess();
  } finally {
    restoreEnv();
  }
}

async function startRole(
  role: "relay" | "proxy",
  env: Record<string, string>,
): Promise<ControllerProcess> {
  Object.assign(process.env, {
    ROLE: role,
    KUBERNETES_ENABLED: "false",
    CONTROLLER_URL: controllerUrl,
    ADMIN_TOKEN: ADMIN,
    RELAY_ADMIN_TOKEN: RELAY_ADMIN,
    WAKE_TOKEN: WAKE,
    PROXY_TOKEN_SECRET: PROXY_SECRET,
    // The role runs on its own, so its scrape listener would only duplicate the
    // two already asserted. 0 also exercises the disabled-metrics path.
    METRICS_PORT: "0",
    ...env,
  });
  try {
    return await startControllerProcess();
  } finally {
    restoreEnv();
  }
}

beforeAll(async () => {
  await startFacilitator();
  controller = await startController();
  api = await startApi();
});

afterAll(async () => {
  // Whichever test stopped them already left these undefined; anything still
  // up here is a failed test that must not leak a listener or a writer lock.
  await api?.stop().catch(() => undefined);
  api = undefined;
  await controller?.stop().catch(() => undefined);
  controller = undefined;
  if (facilitatorServer) await close(facilitatorServer).catch(() => undefined);
  facilitatorServer = undefined;
  facilitator?.close();
  facilitator = undefined;
  restoreEnv();
});

describe("process boot", () => {
  it("answers liveness on both processes", async () => {
    const apiHealth = await getJson<{ ok: boolean; paymentMode: string; network: string }>(
      `${apiUrl}/healthz`,
    );
    expect(apiHealth.status).toBe(200);
    expect(apiHealth.body).toMatchObject({ ok: true, paymentMode: "mock", network: "mock:local" });

    const controllerHealth = await getJson<{ ok: boolean }>(`${controllerUrl}/internal/healthz`);
    expect(controllerHealth.status).toBe(200);
    expect(controllerHealth.body).toEqual({ ok: true });

    // The co-located egress proxy has its own listener and its own probe.
    const proxyHealth = await getJson<{ ok: boolean }>(`${proxyUrl}/healthz`);
    expect(proxyHealth.status).toBe(200);
    expect(proxyHealth.body).toMatchObject({ ok: true });
  });

  it("serves the build stamp on each private metrics listener", async () => {
    for (const [label, url] of [
      ["controller", controllerMetricsUrl],
      ["api", apiMetricsUrl],
    ] as const) {
      const res = await fetch(`${url}/metrics`);
      expect(res.status, `${label} metrics status`).toBe(200);
      expect(res.headers.get("content-type"), `${label} metrics content type`).toContain("text/plain");
      const text = await res.text();
      // One sample, always 1: the label pair is the release identity a scrape
      // uses to tell two builds apart.
      expect(text, `${label} build info`).toMatch(/^sandbox_build_info\{.*\} 1$/m);
      // A sample, not just the # HELP line: registration happens at boot, so a
      // bare name would prove nothing about the scrape-time collector running.
      expect(text, `${label} runtime gauges`).toMatch(/^process_uptime_seconds \d/m);
    }
  });

  it("reports ready once the store, relay and leadership have settled", async () => {
    // `start()` returns before the async acquire (writes enabled, startup
    // recovery) settles, so readiness is polled rather than assumed.
    const controllerReady = await waitFor(
      "controller readiness",
      () => getJson<ReadinessReport>(`${controllerUrl}/internal/readyz`),
      (probe) => probe.status === 200,
    );
    expect(controllerReady.body.ok).toBe(true);
    expect(controllerReady.body.components).toMatchObject({
      store: { ok: true },
      relay: { ok: true },
      provisioner: { ok: true },
      leadership: { ok: true },
      acquire: { ok: true },
    });

    const apiReady = await waitFor(
      "api readiness",
      () => getJson<ReadinessReport>(`${apiUrl}/readyz`),
      (probe) => probe.status === 200,
    );
    expect(apiReady.body.components.controller).toMatchObject({ ok: true });
  });

  it("boots a standalone relay and closes its listener", async () => {
    const relayRole = await startRole("relay", { RELAY_PORT: String(relayRolePort) });
    try {
      const health = await getJson<{ ok: boolean; generation: string }>(
        `http://127.0.0.1:${relayRolePort}/healthz`,
      );
      expect(health.status).toBe(200);
      // A fresh generation per process is what the controller's register fence
      // compares against; it must be present on the probe.
      expect(health.body.generation).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await relayRole.stop();
    }
    expect(
      await connectionRefused(`http://127.0.0.1:${relayRolePort}/healthz`),
      "standalone relay listener still accepts connections",
    ).toBe(true);
  });

  it("boots a standalone proxy and closes its listener", async () => {
    const proxyRole = await startRole("proxy", { X402_PROXY_PORT: String(proxyRolePort) });
    try {
      const health = await getJson<{ ok: boolean }>(
        `http://127.0.0.1:${proxyRolePort}/healthz`,
      );
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ ok: true });
    } finally {
      await proxyRole.stop();
    }
    expect(
      await connectionRefused(`http://127.0.0.1:${proxyRolePort}/healthz`),
      "standalone proxy listener still accepts connections",
    ).toBe(true);
  });

  it("stops both processes and closes every listener", async () => {
    const runningController = controller;
    const runningApi = api;
    if (!runningController || !runningApi) {
      throw new Error("the shutdown case needs both processes from beforeAll");
    }

    await runningController.stop();
    controller = undefined;
    expect(
      await connectionRefused(`${controllerUrl}/internal/healthz`),
      "controller listener still accepts connections",
    ).toBe(true);

    // Readiness has to reflect the controller that just went away, not the
    // report it cached while the process was up (2 s TTL).
    const degraded = await waitFor(
      "api readiness after controller stop",
      () => getJson<ReadinessReport>(`${apiUrl}/readyz`),
      (probe) => probe.status === 503,
    );
    expect(degraded.body).toMatchObject({
      ok: false,
      components: { controller: { ok: false, reason: "unreachable" } },
    });

    await runningApi.stop();
    api = undefined;
    for (const [label, url] of [
      ["api", `${apiUrl}/healthz`],
      ["controller egress proxy", `${proxyUrl}/healthz`],
      ["controller metrics", `${controllerMetricsUrl}/metrics`],
      ["api metrics", `${apiMetricsUrl}/metrics`],
    ] as const) {
      expect(await connectionRefused(url), `${label} listener still accepts connections`).toBe(true);
    }
  });
});
