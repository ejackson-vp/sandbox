/**
 * Child process for the payment-intent concurrency test. Each worker opens its
 * own SQLite connection and waits for the parent's `go` before racing an
 * operation, so claims and completions run in separate processes.
 */
import { Store } from "../../../controller/src/store.js";
import type { PaymentRecord, SessionRecord } from "../../../controller/src/store.js";

interface Init {
  type: "init";
  dbPath: string;
}

type Request =
  | { type: "claim"; opId: string; paymentKey: string; specHash: string; staleMs: number }
  | { type: "complete"; opId: string; paymentKey: string; token: string; sessionId: string };

let store: Store | null = null;

function paymentRecord(key: string): PaymentRecord {
  return {
    paymentKey: key,
    network: "mock:local",
    scheme: "exact",
    asset: "mock:usdc",
    amount: "50000",
    payTo: "0x0000000000000000000000000000000000000402",
    payer: "0x0000000000000000000000000000000000000001",
    transaction: "mock:tx",
    mode: "mock",
  };
}

function sessionRecord(id: string, key: string): SessionRecord {
  const now = Date.now();
  return {
    id,
    capabilityHash: "a".repeat(64),
    capabilityExpiresAt: now + 3_600_000,
    clientPublicKey: "pk",
    clientNonce: "nonce",
    clientSigner: null,
    tier: "standard",
    durationSeconds: 300,
    limits: {
      cpuMillis: 1000,
      memoryMiB: 1024,
      diskMiB: 1024,
      maxOutputBytes: 262_144,
      maxFileBytes: 8 * 1024 * 1024,
      maxCommandSeconds: 300,
      maxProcesses: 256,
    },
    state: "PAID",
    createdAt: now,
    paidAt: now,
    readyAt: null,
    leaseExpiresAt: null,
    terminatingAt: null,
    destroyedAt: null,
    terminationReason: null,
    failureCode: null,
    failureMessage: null,
    attestationJson: null,
    guestPublicKey: null,
    paymentKey: key,
    podName: null,
    runtimeClass: "x402-sandbox",
    executionMode: "dev",
    relayTokenHash: null,
    activeRequestId: null,
    execEpoch: 1,
    relayPurgedAt: null,
    destroyRequested: 0,
    timingsJson: null,
    idlePolicyJson: null,
    maxLifetimeSeconds: null,
    suspendedAt: null,
    resumeCount: 0,
    lastActivityAt: null,
    workspacePvc: null,
    baselineCpuMillis: null,
    baselineMemoryMib: null,
    nodeName: null,
    updatedAt: now,
  };
}

process.on("message", (message: Init | Request) => {
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
      const claim = store.claimPaymentIntent(message.paymentKey, message.specHash, message.staleMs);
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
      const result = store.completeEntitlement(
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
