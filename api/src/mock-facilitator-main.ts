/**
 * Mock facilitator entrypoint (dev/test only). Never expose publicly.
 */
import { createMockFacilitator } from "./mock-facilitator.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3002);
  const dbPath = process.env.MOCK_DB_PATH ?? "/data/facilitator.db";
  const facilitator = await createMockFacilitator({ dbPath });
  const server = facilitator.app.listen(port, "0.0.0.0", () => {
    log.info("mock_facilitator_listening", { port, dbPath, network: "mock:local" });
  });
  const shutdown = () => {
    server.close(() => {
      facilitator.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log.error("fatal_mock_facilitator", { error: (err as Error).message });
  process.exit(1);
});
