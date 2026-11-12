import { describe, expect, it } from "vitest";
import type { SessionLimits } from "../../shared/src/entries/protocol.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import type {  PaymentRecord, SessionRecord  } from "../../controller/src/store/models.js";
import { freshStore } from "../helpers/test-store.js";

const limits: SessionLimits = {
  cpuMillis: 1000,
  memoryMiB: 1024,
  diskMiB: 1024,
  maxOutputBytes: 262144,
  maxFileBytes: 8 * 1024 * 1024,
  maxCommandSeconds: 300,
  maxProcesses: 256,
};

const NOW = Date.now();

function payment(key: string): PaymentRecord {
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

function session(id: string, key: string): SessionRecord {
  return {
    id,
    capabilityHash: "a".repeat(64),
    capabilityExpiresAt: NOW + 3_600_000,
    clientPublicKey: "pk",
    clientNonce: "nonce",
    tier: "standard",
    durationSeconds: 300,
    limits,
    state: "PAID",
    createdAt: NOW,
    paidAt: NOW,
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
    relayTokenHash: "relay-token-hash",
    activeRequestId: null,
    execEpoch: 1,
    relayPurgedAt: null,
    destroyRequested: 0,
    timingsJson: null,
    idlePolicyJson: "{}",
    maxLifetimeSeconds: 28_800,
    suspendedAt: null,
    resumeCount: 0,
    lastActivityAt: null,
    workspacePvc: "pvc-1",
    baselineCpuMillis: null,
    baselineMemoryMib: null,
    nodeName: "node-1",
    updatedAt: NOW,
  };
}

/** Claim then complete, as the API does. */
async function seedEntitlement(store: PostgresStore, key: string, record: SessionRecord): Promise<void> {
  const claim = await store.claimPaymentIntent(key, "a".repeat(64), 30_000);
  if (claim.status !== "claimed") throw new Error("expected claim");
  await store.completeEntitlement(key, claim.token, payment(key), record);
}

describe("lifecycle persistence transitions", () => {
  it("walks PAID -> PROVISIONING -> READY -> SUSPENDING -> SUSPENDED -> RESUMING -> READY", async () => {
    const store = await freshStore();
    try {
      const key = "b".repeat(64);
      const id = "sbx_000000000000000000000001";
      await seedEntitlement(store, key, session(id, key));

      expect(await store.setProvisioning(id, "pod-1")).toBe(true);
      await store.setRelayToken(id, "relay-hash-1");
      expect((await store.getSession(id))?.state).toBe("PROVISIONING");

      const readyAt = NOW + 1000;
      expect(await store.setReady(id, readyAt, readyAt + 60_000, "{}", "guest-pk")).toBe(true);
      expect((await store.getSession(id))?.state).toBe("READY");

      expect(await store.markSuspending(id)).toBe(true);
      expect((await store.getSession(id))?.state).toBe("SUSPENDING");
      expect(await store.markSuspended(id, readyAt + 2000)).toBe(true);
      expect((await store.getSession(id))?.state).toBe("SUSPENDED");
      expect((await store.getSession(id))?.podName).toBeNull();

      expect(await store.markResuming(id, "pod-2")).toBe(true);
      await store.setRelayToken(id, "relay-hash-2");
      expect((await store.getSession(id))?.state).toBe("RESUMING");
      expect((await store.getSession(id))?.resumeCount).toBe(1);

      const resumedAt = readyAt + 3000;
      expect(await store.setReady(id, resumedAt, resumedAt + 60_000, "{}", "guest-pk-2")).toBe(true);
      expect((await store.getSession(id))?.state).toBe("READY");
    } finally {
      await store.close();
    }
  });

  it("refuses to mark SUSPENDED unless the session is SUSPENDING", async () => {
    const store = await freshStore();
    try {
      const key = "c".repeat(64);
      const id = "sbx_000000000000000000000002";
      await seedEntitlement(store, key, session(id, key));
      await store.setProvisioning(id, "pod-1");
      await store.setRelayToken(id, "relay-hash");
      await store.setReady(id, NOW + 1000, NOW + 60_000, "{}", "guest-pk");

      expect(await store.markSuspended(id, NOW + 2000)).toBe(false);
      expect((await store.getSession(id))?.state).toBe("READY");
    } finally {
      await store.close();
    }
  });
});
