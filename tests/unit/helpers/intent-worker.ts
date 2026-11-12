/**
 * Child process for the payment-intent concurrency test. Each worker opens its
 * own SQLite connection and waits for the parent's `go` before racing an
 * operation, so claims and completions run in separate processes.
 */
import { Store } from "../../../controller/src/store.js";
import type { PaymentRecord, SessionRecord } from "../../../controller/src/store.js";
import { limitsFor, paymentFixture, sessionFixture } from "../../helpers/store-fixtures.js";

interface Init {
  type: "init";
  dbPath: string;
}

type Request =
  | { type: "claim"; opId: string; paymentKey: string; specHash: string; staleMs: number }
  | { type: "complete"; opId: string; paymentKey: string; token: string; sessionId: string };

let store: Store | null = null;

function paymentRecord(key: string): PaymentRecord {
  return paymentFixture({
    paymentKey: key,
    network: "mock:local",
    payer: "0x0000000000000000000000000000000000000001",
    transaction: "mock:tx",
  });
}

function sessionRecord(id: string, key: string): SessionRecord {
  return sessionFixture({
    id,
    paymentKey: key,
    clientPublicKey: "pk",
    clientNonce: "nonce",
    tier: "standard",
    durationSeconds: 300,
    limits: limitsFor("unit"),
  });
}

process.on("message", async (message: Init | Request) => {
  if (message.type === "init") {
    try {
      store = new Store(message.dbPath);
    } catch (err) {
      process.send?.({ type: "fatal", error: `startup: ${(err as Error).message}` });
      process.exit(1);
      return;
    }
    process.send?.({ type: "ready" });
    return;
  }
  if (!store) return;
  if (message.type === "claim") {
    try {
      const claim = await store.claimPaymentIntent(message.paymentKey, message.specHash, message.staleMs);
      process.send?.({
        type: "result",
        opId: message.opId,
        status: claim.status,
        ...(claim.status === "claimed" ? { token: claim.token, recovered: claim.recovered } : {}),
      });
    } catch (err) {
      process.send?.({ type: "result", opId: message.opId, error: (err as Error).message });
    }
    return;
  }
  if (message.type === "complete") {
    try {
      const result = await store.completeEntitlement(
        message.paymentKey,
        message.token,
        paymentRecord(message.paymentKey),
        sessionRecord(message.sessionId, message.paymentKey),
      );
      process.send?.({ type: "result", opId: message.opId, ok: true, ...result });
    } catch (err) {
      process.send?.({
        type: "result",
        opId: message.opId,
        ok: false,
        error: (err as Error).name,
      });
    }
  }
});
