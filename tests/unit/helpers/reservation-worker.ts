/**
 * Child process for the real SQLite concurrency test. Each worker opens its
 * own connection, waits for the parent's barrier, then races one admission.
 */
import { Store } from "../../../controller/src/store.js";
import type { CapacitySnapshot, SandboxResourceRequest } from "../../../controller/src/capacity/types.js";

interface Init {
  type: "init";
  dbPath: string;
  paymentKey: string;
  specHash: string;
  snapshot: CapacitySnapshot;
  request: SandboxResourceRequest;
}

process.on("message", (message: Init) => {
  if (message.type !== "init") return;
  let store: Store;
  try {
    store = new Store(message.dbPath);
  } catch (err) {
    process.send?.({ type: "fatal", error: `startup: ${(err as Error).message}` });
    process.exit(1);
    return;
  }
  process.send?.({ type: "ready" });
  process.on("message", (next: { type: "go" }) => {
    if (next.type !== "go") return;
    try {
      const result = store.reservations.admit(message.snapshot, message.request, {
        paymentKey: message.paymentKey,
        specHash: message.specHash,
        ttlMs: 60_000,
      });
      process.send?.({ type: "result", admitted: result.admitted });
    } catch (err) {
      process.send?.({ type: "result", error: (err as Error).message });
    } finally {
      store.close();
      process.exit(0);
    }
  });
});
