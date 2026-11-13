/**
 * API server entrypoint.
 *
 * `start()` is the whole boot path and returns a handle; `main()` is only the
 * signal wiring around it. The split exists for coverage: a spawned child
 * process reports none, so the only way to prove this file starts a deployment
 * is to run it in the test process and stop it again
 * (tests/integration/process-boot.test.ts). `node api/dist/main.js` still calls
 * `main`, so the container behaves exactly as it did.
 */
import type { Server } from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createApp } from "./server.js";
import { ControllerClient } from "./controller-client.js";
import { log, registerBuildInfo, registerRuntimeMetrics, startMetricsServer } from "@x402s/shared/runtime";

export interface ApiProcess {
  /** Close both listeners. Resolves once they stop accepting connections. */
  stop(): Promise<void>;
}

export async function start(): Promise<ApiProcess> {
  const config = loadConfig();
  const controller = new ControllerClient(
    config.controllerUrl,
    config.controllerAdminToken,
    config.controllerTls,
  );
  const app = await createApp({ config, controller });

  // Private scrape listener. Bound to the pod network; NetworkPolicy admits
  // only the monitoring namespace. The public listener never serves /metrics.
  const runtime = registerRuntimeMetrics();
  registerBuildInfo();
  let metricsServer: Server | undefined;
  if (config.metricsPort > 0) {
    metricsServer = await startMetricsServer({
      port: config.metricsPort,
      host: config.metricsHost,
      onScrape: () => runtime.collect(),
    });
    log.info("metrics_listening", { port: config.metricsPort, host: config.metricsHost });
  }

  const server = app.listen(config.port, "0.0.0.0", () => {
    log.info("api_listening", {
      port: config.port,
      paymentMode: config.paymentMode,
      network: config.network,
      controllerUrl: config.controllerUrl,
      httpHeadersTimeoutMs: config.httpHeadersTimeoutMs,
      httpRequestTimeoutMs: config.httpRequestTimeoutMs,
    });
  });

  // Node's defaults are 60 s for headers and 300 s for the whole request, which
  // leaves a slowloris-shaped client a long time per connection. Both timers
  // stop when the request has been received: they do not cap how long a handler
  // may run, so `exec` with a long `waitMs` is unaffected.
  server.headersTimeout = config.httpHeadersTimeoutMs;
  server.requestTimeout = config.httpRequestTimeoutMs;

  const stop = async (): Promise<void> => {
    runtime.stop();
    await Promise.all([
      closeServer(server),
      metricsServer === undefined ? undefined : closeServer(metricsServer),
    ]);
  };
  return { stop };
}

function closeServer(server: Server): Promise<void> {
  // The callback receives an error when the server was never listening; every
  // caller here only wants "it is closed now", so the error is not propagated.
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function main(): Promise<void> {
  const starting = start();
  // Registered before the await: a SIGTERM during the facilitator handshake
  // (bounded by FACILITATOR_INIT_TIMEOUT_MS) has to take the graceful path.
  // Installing the handlers afterwards left that whole window, which is the
  // longest one either entrypoint has, on Node's default exit. The handler
  // waits for the handle it is about to be given.
  const shutdown = (signal: string) => {
    log.info("shutting_down", { signal });
    void starting
      .then((running) => running.stop())
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  await starting;
}

/**
 * `start` is exported so tests can run the boot path in-process. The module has
 * to know whether it was executed or imported, or importing it in a test would
 * start a second listener. When the check cannot answer, the process runs: a
 * server that silently does nothing is the worse failure.
 */
function invokedAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return true;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return true;
  }
}

if (invokedAsScript()) {
  main().catch((err) => {
    log.error("fatal_startup_error", { error: (err as Error).message });
    process.exit(1);
  });
}
