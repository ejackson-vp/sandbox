/**
 * API server entrypoint.
 */
import type { Server } from "node:http";
import { loadConfig } from "./config.js";
import { createApp } from "./server.js";
import { ControllerClient } from "./controller-client.js";
import { log, registerBuildInfo, registerRuntimeMetrics, startMetricsServer } from "@x402s/shared";

async function main(): Promise<void> {
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

  const shutdown = (signal: string) => {
    log.info("shutting_down", { signal });
    runtime.stop();
    metricsServer?.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("fatal_startup_error", { error: (err as Error).message });
  process.exit(1);
});
