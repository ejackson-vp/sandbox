/**
 * Effectively-once refund execution (#31).
 *
 * The worker used to list `REFUND_PENDING` rows, call the provider, then write
 * the ledger. A crash between the call and the write, or two workers listing the
 * same row, sent the refund twice. What is pinned here:
 *
 *  - a durable claim makes two workers disjoint, at the store and at the worker;
 *  - every attempt for a row presents the same `refund:<paymentKey>` key, so a
 *    resend after a crash or an ambiguous timeout is a provider no-op;
 *  - a definite refusal counts an attempt and backs off, and an exhausted row
 *    stops being sent while staying visible;
 *  - `REFUNDED` is terminal for the worker;
 *  - a relay-loss session is refunded even though it reached READY, while a
 *    client destroy after READY is not.
 *
 * The provider is a fake that dedupes by key, standing in for the contract the
 * real webhook must implement. No test here talks to a real provider.
 */
import { describe, expect, it, vi } from "vitest";
import type { PaymentRecord, SessionRecord } from "../../controller/src/store/models.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import type { RefundWorkerStore } from "../../controller/src/store/ports.js";
import {
  RefundSendUnknownError,
  RefundWorker,
  type RefundRequest,
} from "../../controller/src/refund-worker.js";
import { RefundService } from "../../controller/src/refunds.js";
import { freshStore, sqlExec } from "../helpers/test-store.js";

const NOW = Date.now();
const PAYER = "0x00000000000000000000000000000000000000aa";

const SESSION_LIMITS = {
  cpuMillis: 500,
  memoryMiB: 512,
  diskMiB: 256,
  maxOutputBytes: 262_144,
  maxFileBytes: 8 * 1024 * 1024,
  maxCommandSeconds: 300,
  maxProcesses: 64,
};

function keyOf(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

/**
 * A provider that honours the key contract: the first call for a key moves
 * funds and records a transaction, and every later call with that key returns
 * the original transaction without a second transfer.
 */
class FakeProvider {
  readonly calls: RefundRequest[] = [];
  readonly transfers = new Map<string, string>();
  /** Called before the answer; lets a test fail or hang one attempt. */
  beforeAnswer: ((call: number) => void) | null = null;

  readonly executor = {
    refund: async (request: RefundRequest) => {
      this.calls.push(request);
      const existing = this.transfers.get(request.idempotencyKey);
      const transaction = existing ?? `0xtx${this.transfers.size + 1}`;
      if (!existing) this.transfers.set(request.idempotencyKey, transaction);
      const call = this.calls.length;
      this.beforeAnswer?.(call);
      return { transaction };
    },
  };

  get sends(): number {
    return this.calls.length;
  }
}

async function seedPending(store: PostgresStore, key: string): Promise<void> {
  await store.insertUnclaimedLedger({
    paymentKey: key,
    sessionId: `unsettled:${key}`,
    payer: PAYER,
    amount: "50000",
    asset: "mock:usdc",
    network: "mock:local",
    mode: "testnet",
    status: "REFUND_PENDING",
    reason: "no_service_delivered:provisioning_timeout",
    settlementNonce: `0x${"2".repeat(64)}`,
  });
}

function paymentRecord(key: string, mode: "mock" | "testnet"): PaymentRecord {
  return {
    paymentKey: key,
    network: "mock:local",
    scheme: "exact",
    asset: "mock:usdc",
    amount: "50000",
    payTo: "0x0000000000000000000000000000000000000402",
    payer: PAYER,
    transaction: mode === "mock" ? "mock:tx" : undefined,
    mode,
    settlementNonce: `0x${"3".repeat(64)}`,
  };
}

function sessionRecord(id: string, key: string, client: string): SessionRecord {
  return {
    id,
    capabilityHash: "a".repeat(64),
    capabilityExpiresAt: NOW + 3_600_000,
    clientPublicKey: `client-${client}`,
    clientNonce: `nonce-${client}`,
    clientSigner: PAYER,
    tier: "short",
    durationSeconds: 60,
    limits: SESSION_LIMITS,
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
    updatedAt: NOW,
  } as unknown as SessionRecord;
}

/** A paid, settled session that then ended in the given terminal state. */
async function seedEndedSession(
  store: PostgresStore,
  options: {
    key: string;
    id: string;
    state: "FAILED" | "DESTROYED" | "EXPIRED";
    terminationReason: string;
    failureCode: string | null;
    readyAt: number | null;
  },
): Promise<SessionRecord> {
  const claim = await store.claimPaymentIntent(options.key, "b".repeat(64), 30_000);
  if (claim.status !== "claimed") throw new Error(`expected a claim, got ${claim.status}`);
  await store.completeEntitlement(
    options.key,
    claim.token,
    paymentRecord(options.key, "testnet"),
    sessionRecord(options.id, options.key, options.id),
  );
  await sqlExec(
    `UPDATE sessions
        SET state = $1, ready_at = $2, termination_reason = $3, failure_code = $4
      WHERE id = $5`,
    [options.state, options.readyAt, options.terminationReason, options.failureCode, options.id],
  );
  const session = await store.getSession(options.id);
  if (!session) throw new Error("seeded session disappeared");
  return session;
}

/**
 * The store a crashed pass would leave behind: it can claim, but the process
 * dies before it can record the provider's transaction. The row stays
 * `REFUND_SENDING`, which is exactly the state a restart has to recover.
 */
function storeThatDiesBeforeRecording(store: PostgresStore): RefundWorkerStore {
  return {
    countLedgerByStatus: (status) => store.countLedgerByStatus(status),
    claimRefunds: (request) => store.claimRefunds(request),
    completeRefundClaim: async () => {
      throw new Error("process died before the ledger write");
    },
    releaseRefundClaim: (key, token, error, nextAttemptAt) =>
      store.releaseRefundClaim(key, token, error, nextAttemptAt),
  };
}

describe("refund claim", () => {
  it("gives two concurrent claimers disjoint rows", async () => {
    const store = await freshStore();
    const keys = [keyOf(1), keyOf(2), keyOf(3)];
    for (const key of keys) await seedPending(store, key);

    const request = (token: string) => ({
      nowMs: Date.now(),
      leaseCutoffMs: Date.now() - 60_000,
      limit: 3,
      maxAttempts: 5,
      claimToken: token,
    });
    const [first, second] = await Promise.all([
      store.claimRefunds(request("a".repeat(32))),
      store.claimRefunds(request("b".repeat(32))),
    ]);

    const claimed = [...first, ...second].map((claim) => claim.ledger.paymentKey);
    expect(new Set(claimed).size).toBe(3);
    expect(claimed).toHaveLength(3);
    // Every claimed row is fenced and carries the stable key from the moment it
    // is owned, not just when it is sent.
    for (const claim of [...first, ...second]) {
      expect(claim.ledger.status).toBe("REFUND_SENDING");
      expect(claim.ledger.refundClaimToken).not.toBeNull();
      expect(claim.ledger.refundIdempotencyKey).toBe(`refund:${claim.ledger.paymentKey}`);
      expect(claim.reclaimed).toBe(false);
    }
  });

  it("does not claim a row that is at its attempt limit", async () => {
    const store = await freshStore();
    const key = keyOf(9);
    await seedPending(store, key);
    await sqlExec("UPDATE payment_ledger SET refund_attempts = 2 WHERE payment_key = $1", [key]);

    const claimed = await store.claimRefunds({
      nowMs: Date.now(),
      leaseCutoffMs: 0,
      limit: 10,
      maxAttempts: 2,
      claimToken: "c".repeat(32),
    });
    expect(claimed).toHaveLength(0);
  });

  it("refuses the direct refund path while a claim is in flight", async () => {
    const store = await freshStore();
    const key = keyOf(15);
    await seedPending(store, key);
    await store.claimRefunds({
      nowMs: Date.now(),
      leaseCutoffMs: 0,
      limit: 1,
      maxAttempts: 5,
      claimToken: "d".repeat(32),
    });

    // An operator recording a transaction here could race a live send, so the
    // direct path is refused and the row stays owned by the worker.
    expect(await store.markRefunded(key, "0xmanual", "manual_refund")).toBe(false);
    const row = (await store.getLedgerByPayment(key))!;
    expect(row.status).toBe("REFUND_SENDING");
    expect(row.refundTransaction).toBeNull();
  });
});

describe("refund worker", () => {
  it("recovers a crash after the provider paid, resending the same key", async () => {
    const store = await freshStore();
    const key = keyOf(10);
    await seedPending(store, key);
    const provider = new FakeProvider();
    const clock = { now: NOW };
    const options = {
      maxAttempts: 5,
      retryBaseMs: 1000,
      claimLeaseMs: 30_000,
      limit: 10,
      now: () => clock.now,
    };

    // The pass pays, then "dies" before it can record the transaction.
    const crashed = new RefundWorker(storeThatDiesBeforeRecording(store), provider.executor, options);
    const first = await crashed.run();
    expect(first).toMatchObject({ attempted: 1, refunded: 0, unknown: 1 });
    expect(provider.sends).toBe(1);
    const sentKey = provider.calls[0]!.idempotencyKey;
    expect(sentKey).toBe(`refund:${key}`);

    const pendingRow = (await store.getLedgerByPayment(key))!;
    expect(pendingRow.status).toBe("REFUND_SENDING");
    expect(pendingRow.refundClaimToken).not.toBeNull();

    // A restart inside the lease does not resend: the claim is still owned.
    const early = await new RefundWorker(store, provider.executor, options).run();
    expect(early.attempted).toBe(0);
    expect(provider.sends).toBe(1);

    // Past the lease the row is reclaimed and resent with the same key. The fake
    // provider answers with the original transaction and moves no funds again.
    clock.now = NOW + 31_000;
    const recovered = await new RefundWorker(store, provider.executor, options).run();
    expect(recovered).toMatchObject({ attempted: 1, reclaimed: 1, refunded: 1 });
    expect(provider.sends).toBe(2);
    expect(provider.calls[1]!.idempotencyKey).toBe(sentKey);
    expect(provider.transfers.size).toBe(1);

    const refundedRow = (await store.getLedgerByPayment(key))!;
    expect(refundedRow.status).toBe("REFUNDED");
    expect(refundedRow.refundTransaction).toBe(provider.transfers.get(sentKey));
    expect(refundedRow.refundClaimToken).toBeNull();
  });

  it("sends exactly once when two workers run concurrently", async () => {
    const store = await freshStore();
    const key = keyOf(11);
    await seedPending(store, key);
    const provider = new FakeProvider();
    const options = { maxAttempts: 5, retryBaseMs: 1000, claimLeaseMs: 30_000, limit: 10 };

    // Hold the first worker inside the provider call so the second worker's claim
    // genuinely overlaps the first worker's ownership.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowProvider = {
      refund: async (request: RefundRequest) => {
        const answer = await provider.executor.refund(request);
        await gate;
        return answer;
      },
    };

    const first = new RefundWorker(store, slowProvider, options).run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await new RefundWorker(store, provider.executor, options).run();
    expect(second.attempted).toBe(0);

    release();
    const firstResult = await first;
    expect(firstResult).toMatchObject({ attempted: 1, refunded: 1 });
    expect(provider.sends).toBe(1);
    expect(provider.transfers.size).toBe(1);
    expect((await store.getLedgerByPayment(key))?.status).toBe("REFUNDED");
  });

  it("retries an ambiguous timeout with the same key instead of releasing", async () => {
    const store = await freshStore();
    const key = keyOf(12);
    await seedPending(store, key);
    const provider = new FakeProvider();
    // The first attempt reaches the provider, which pays, and the answer is lost.
    provider.beforeAnswer = (call) => {
      if (call === 1) throw new RefundSendUnknownError("refund webhook unreachable: timeout");
    };
    const clock = { now: NOW };
    const options = {
      maxAttempts: 5,
      retryBaseMs: 1000,
      claimLeaseMs: 30_000,
      limit: 10,
      now: () => clock.now,
    };

    const first = await new RefundWorker(store, provider.executor, options).run();
    expect(first).toMatchObject({ attempted: 1, refunded: 0, failed: 0, unknown: 1 });
    const row = (await store.getLedgerByPayment(key))!;
    expect(row.status).toBe("REFUND_SENDING");
    // An unknown outcome is not a failed attempt: the row is NOT released with a
    // backoff, it waits for the lease.
    expect(row.refundAttempts).toBe(0);
    expect(row.refundNextAttemptAt).toBeNull();

    clock.now = NOW + 31_000;
    const second = await new RefundWorker(store, provider.executor, options).run();
    expect(second).toMatchObject({ attempted: 1, reclaimed: 1, refunded: 1 });
    expect(provider.calls[1]!.idempotencyKey).toBe(provider.calls[0]!.idempotencyKey);
    expect(provider.transfers.size).toBe(1);
    expect((await store.getLedgerByPayment(key))?.status).toBe("REFUNDED");
  });

  it("counts a refusal, backs off, and stops sending at the attempt limit", async () => {
    const store = await freshStore();
    const key = keyOf(13);
    await seedPending(store, key);
    const executor = {
      refund: vi.fn(async () => {
        throw new Error("treasury offline");
      }),
    };
    const clock = { now: NOW };
    const options = {
      maxAttempts: 2,
      retryBaseMs: 1000,
      claimLeaseMs: 30_000,
      limit: 10,
      now: () => clock.now,
    };

    const first = await new RefundWorker(store, executor, options).run();
    expect(first).toMatchObject({ attempted: 1, failed: 1, exhausted: 0 });
    const afterFirst = (await store.getLedgerByPayment(key))!;
    expect(afterFirst.status).toBe("REFUND_PENDING");
    expect(afterFirst.refundAttempts).toBe(1);
    expect(afterFirst.refundLastError).toBe("treasury offline");
    expect(afterFirst.refundClaimToken).toBeNull();
    expect(afterFirst.refundNextAttemptAt).toBe(NOW + 1000);

    // Inside the backoff the row is not due, so it is not even claimed.
    clock.now = NOW + 500;
    const tooEarly = await new RefundWorker(store, executor, options).run();
    expect(tooEarly.attempted).toBe(0);
    expect(executor.refund).toHaveBeenCalledTimes(1);

    // The second failure reaches the limit: the row is PENDING at max attempts.
    clock.now = NOW + 1000;
    const last = await new RefundWorker(store, executor, options).run();
    expect(last).toMatchObject({ attempted: 1, failed: 0, exhausted: 1 });
    const exhaustedRow = (await store.getLedgerByPayment(key))!;
    expect(exhaustedRow.status).toBe("REFUND_PENDING");
    expect(exhaustedRow.refundAttempts).toBe(2);

    // Never sent again, and still visible in the pending list.
    clock.now = NOW + 86_400_000;
    const afterLimit = await new RefundWorker(store, executor, options).run();
    expect(afterLimit.attempted).toBe(0);
    expect(executor.refund).toHaveBeenCalledTimes(2);
    expect(await store.listLedgerByStatus("REFUND_PENDING")).toHaveLength(1);
  });

  it("never sends a row that is already REFUNDED", async () => {
    const store = await freshStore();
    const key = keyOf(14);
    await seedPending(store, key);
    const provider = new FakeProvider();
    const clock = { now: NOW };
    const options = {
      maxAttempts: 5,
      retryBaseMs: 1000,
      claimLeaseMs: 30_000,
      limit: 10,
      now: () => clock.now,
    };

    await new RefundWorker(store, provider.executor, options).run();
    expect(provider.sends).toBe(1);

    // A day later the row is still REFUNDED and the claim query cannot see it.
    clock.now = NOW + 86_400_000;
    const second = await new RefundWorker(store, provider.executor, options).run();
    expect(second.attempted).toBe(0);
    expect(provider.sends).toBe(1);
    expect((await store.getLedgerByPayment(key))?.status).toBe("REFUNDED");
  });
});

describe("relay-loss refund policy", () => {
  it("refunds a READY session that relay loss interrupted", async () => {
    const store = await freshStore();
    const key = keyOf(20);
    const session = await seedEndedSession(store, {
      key,
      id: "sbx_relay_lost",
      state: "FAILED",
      terminationReason: "failure:relay_lost",
      failureCode: "relay_lost",
      readyAt: NOW - 60_000,
    });

    const outcome = await new RefundService(store).refund(session, "FAILED");
    expect(outcome).toBe("pending");
    const ledger = (await store.getLedgerByPayment(key))!;
    expect(ledger.status).toBe("REFUND_PENDING");
    expect(ledger.reason).toBe("service_interrupted:relay_lost");
  });

  it("does not refund a client destroy after READY", async () => {
    const store = await freshStore();
    const key = keyOf(21);
    const session = await seedEndedSession(store, {
      key,
      id: "sbx_client_destroy",
      state: "DESTROYED",
      terminationReason: "client_destroy",
      failureCode: null,
      readyAt: NOW - 60_000,
    });

    expect(await new RefundService(store).refund(session, "DESTROYED")).toBe("not_applicable");
    expect((await store.getLedgerByPayment(key))?.status).toBe("SETTLED");
  });

  it("reconciles a terminal relay-loss row left SETTLED by a crash", async () => {
    const store = await freshStore();
    const lostKey = keyOf(22);
    await seedEndedSession(store, {
      key: lostKey,
      id: "sbx_relay_lost_unrepaired",
      state: "FAILED",
      terminationReason: "failure:relay_lost",
      failureCode: "relay_lost",
      readyAt: NOW - 60_000,
    });
    const keptKey = keyOf(23);
    await seedEndedSession(store, {
      key: keptKey,
      id: "sbx_destroyed_unrepaired",
      state: "DESTROYED",
      terminationReason: "client_destroy",
      failureCode: null,
      readyAt: NOW - 60_000,
    });

    await new RefundService(store).reconcile();

    expect((await store.getLedgerByPayment(lostKey))?.status).toBe("REFUND_PENDING");
    expect((await store.getLedgerByPayment(keptKey))?.status).toBe("SETTLED");
  });
});
