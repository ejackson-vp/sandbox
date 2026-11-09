/**
 * API server entrypoint.
 */
import { loadConfig } from "./config.js";
import { createApp } from "./server.js";
import { ControllerClient } from "./controller-client.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const controller = new ControllerClient(
    config.controllerUrl,
    config.controllerAdminToken,
    config.controllerTls,
  );
  const app = await createApp({ config, controller });

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
