import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionLimits } from "../../shared/src/index.js";
import { Store, type PaymentRecord, type SessionRecord } from "../../controller/src/store.js";

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

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "x402-store-"));
  dirs.push(dir);
  return new Store(join(dir, "controller.db"));
}

describe("lifecycle persistence transitions", () => {
  it("walks PAID -> PROVISIONING -> READY -> SUSPENDING -> SUSPENDED -> RESUMING -> READY", () => {
    const store = freshStore();
    try {
      const key = "b".repeat(64);
      const id = "sbx_000000000000000000000001";
      store.completeEntitlement(key, payment(key), session(id, key));

      expect(store.setProvisioning(id, "pod-1")).toBe(true);
      store.setRelayToken(id, "relay-hash-1");
      expect(store.getSession(id)?.state).toBe("PROVISIONING");

      const readyAt = NOW + 1000;
      expect(store.setReady(id, readyAt, readyAt + 60_000, "{}", "guest-pk")).toBe(true);
      expect(store.getSession(id)?.state).toBe("READY");

      expect(store.markSuspending(id)).toBe(true);
      expect(store.getSession(id)?.state).toBe("SUSPENDING");
      expect(store.markSuspended(id, readyAt + 2000)).toBe(true);
      expect(store.getSession(id)?.state).toBe("SUSPENDED");
      expect(store.getSession(id)?.podName).toBeNull();

      expect(store.markResuming(id, "pod-2")).toBe(true);
      store.setRelayToken(id, "relay-hash-2");
      expect(store.getSession(id)?.state).toBe("RESUMING");
      expect(store.getSession(id)?.resumeCount).toBe(1);

      const resumedAt = readyAt + 3000;
      expect(store.setReady(id, resumedAt, resumedAt + 60_000, "{}", "guest-pk-2")).toBe(true);
      expect(store.getSession(id)?.state).toBe("READY");
    } finally {
      store.close();
    }
  });

  it("refuses to mark SUSPENDED unless the session is SUSPENDING", () => {
    const store = freshStore();
    try {
      const key = "c".repeat(64);
      const id = "sbx_000000000000000000000002";
      store.completeEntitlement(key, payment(key), session(id, key));
      store.setProvisioning(id, "pod-1");
      store.setRelayToken(id, "relay-hash");
      store.setReady(id, NOW + 1000, NOW + 60_000, "{}", "guest-pk");

      expect(store.markSuspended(id, NOW + 2000)).toBe(false);
      expect(store.getSession(id)?.state).toBe("READY");
    } finally {
      store.close();
    }
  });
});
