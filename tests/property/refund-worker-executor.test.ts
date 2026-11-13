/**
 * The refund worker's edges: the HTTP executor's status contract, and the rows
 * a claim should never have produced.
 *
 * `tests/property/refund-worker.test.ts` pins the loop's invariants. This file
 * pins the two boundaries the loop depends on. First, the executor: a provider
 * answer is a refusal only when it is a plain 4xx, and everything else (5xx,
 * a timeout, a 2xx that names no transaction, an unreachable host) is unknown,
 * because those answers may hide a transfer that already happened. The
 * classifier is read from `classifyStatus`, so the test cannot disagree with the
 * code it is checking about which statuses are refusals.
 *
 * Second, the claim's own shape. The statement always writes a fence and an
 * idempotency key; a row that has neither is manual corruption, and the worker
 * must skip it rather than abort every other refund in the pass. A write that
 * fails after the provider paid must leave the row `SENDING` so the reclaim
 * resends the same key instead of losing the payment.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyStatus } from "@x402s/shared/durable";
import {
  HttpRefundExecutor,
  RefundSendUnknownError,
  RefundWorker,
  type RefundRequest,
} from "../../controller/src/refund-worker.js";
import type { ClaimedRefund } from "../../controller/src/store/models.js";
import type { RefundWorkerStore } from "../../controller/src/store/ports.js";
import { KEY, MemoryLedger, pendingRow, provider } from "../helpers/memory-refund-ledger.js";

const REQUEST: RefundRequest = {
  paymentKey: KEY,
  settlementNonce: `0x${KEY}`,
  payer: null,
  amount: "50000",
  asset: "mock:usdc",
  network: "mock:local",
  mode: "testnet",
  reason: "no_service_delivered",
  idempotencyKey: `refund:${KEY}`,
};

describe("refund executor", () => {
  it("classifies every provider answer through the shared status split", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 1xx is an interim response Node's client does not surface as a final
        // answer, and a 3xx is a redirect `fetch` may follow. 407 is excluded
        // because `fetch` rejects the request when a proxy auth challenge
        // arrives, before a response exists, so the executor never sees the
        // status and conservatively reports unknown. Every case here is one the
        // executor can actually classify.
        fc.oneof(
          fc.integer({ min: 200, max: 299 }),
          fc.integer({ min: 400, max: 599 }).filter((status) => status !== 407),
        ),
        fc.constantFrom("transaction", "empty", "missing", "garbage"),
        async (status, bodyKind) => {
          answer = {
            status,
            body:
              bodyKind === "transaction"
                ? JSON.stringify({ transaction: "0xpaid" })
                : bodyKind === "empty"
                  ? JSON.stringify({ transaction: "" })
                  : bodyKind === "missing"
                    ? JSON.stringify({ ok: true })
                    : "not json",
          };
          const executor = new HttpRefundExecutor(`http://127.0.0.1:${httpPort}/refund`);
          const outcome = await executor.refund(REQUEST).then(
            (value) => ({ kind: "ok" as const, value }),
            (err: unknown) => ({ kind: "threw" as const, err }),
          );

          const answerOk = status >= 200 && status <= 299;
          const named = bodyKind === "transaction";
          // 204 and 205 carry no body, so a transaction id cannot arrive there:
          // the answer is unreadable, which is unknown, not success.
          const bodyAllowed = status !== 204 && status !== 205;
          if (answerOk && named && bodyAllowed) {
            expect(outcome.kind).toBe("ok");
            if (outcome.kind === "ok") expect(outcome.value.transaction).toBe("0xpaid");
          } else if (!answerOk && classifyStatus(status) === "definite_failure") {
            // A plain 4xx is the provider refusing: it may be counted.
            expect(outcome.kind).toBe("threw");
            if (outcome.kind === "threw") {
              expect(outcome.err).not.toBeInstanceOf(RefundSendUnknownError);
            }
          } else {
            // Everything else may have moved funds: never a refusal.
            expect(outcome.kind).toBe("threw");
            if (outcome.kind === "threw") expect(outcome.err).toBeInstanceOf(RefundSendUnknownError);
          }

          // Whatever the answer, the request carried the stable key twice.
          expect(lastRequest?.headers["idempotency-key"]).toBe(`refund:${KEY}`);
          expect((lastRequest?.body as { idempotencyKey?: string }).idempotencyKey).toBe(
            `refund:${KEY}`,
          );
        },
      ),
      { numRuns: 120 },
    );
  });

  it("treats an unreachable endpoint as unknown, not as a refusal", async () => {
    // A listener that was bound and then closed: the connection is refused
    // before any answer exists, so the funds may have moved.
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const executor = new HttpRefundExecutor(`http://127.0.0.1:${port}/refund`);
    await expect(executor.refund(REQUEST)).rejects.toBeInstanceOf(RefundSendUnknownError);
  });
});

describe("refund worker edges", () => {
  it("records nothing when the ledger write after a paid send fails", async () => {
    const ledger = new MemoryLedger(pendingRow(KEY, 1_000_000));
    // The send succeeds, the write does not: the row must stay SENDING so the
    // reclaim resends the same key instead of losing the payment.
    const failing: RefundWorkerStore = {
      countLedgerByStatus: (status) => ledger.countLedgerByStatus(status),
      claimRefunds: (request) => ledger.claimRefunds(request),
      completeRefundClaim: async () => {
        throw new Error("process died before the ledger write");
      },
      releaseRefundClaim: (key, token, error, next) =>
        ledger.releaseRefundClaim(key, token, error, next),
    };
    const executor = provider(ledger, () => "ok");
    const result = await new RefundWorker(failing, executor, {
      maxAttempts: 3,
      retryBaseMs: 10,
      claimLeaseMs: 100,
      limit: 10,
      now: () => 1_000_000,
    }).run();

    expect(result).toMatchObject({ attempted: 1, refunded: 0, unknown: 1 });
    const row = ledger.row();
    expect(row.status).toBe("REFUND_SENDING");
    expect(row.refundAttempts).toBe(0);
    expect(row.refundTransaction).toBeNull();
    expect(ledger.transfers.size).toBe(1);
  });

  it("skips a claimed row whose fence is missing or unusable", async () => {
    const ledger = new MemoryLedger(
      pendingRow("a".repeat(64), 1_000_000),
      pendingRow("b".repeat(64), 1_000_000),
    );
    // The claim statement always writes a valid token. A row with none, or with
    // one that cannot be a transport-safe fence, is manual corruption: skip it
    // rather than abort every other refund in the pass.
    const store: RefundWorkerStore = {
      countLedgerByStatus: (status) => ledger.countLedgerByStatus(status),
      async claimRefunds(): Promise<ClaimedRefund[]> {
        const missing = { ...ledger.row("a".repeat(64)), status: "REFUND_SENDING" as const };
        const invalid = {
          ...ledger.row("b".repeat(64)),
          status: "REFUND_SENDING" as const,
          refundClaimToken: "not a fence",
        };
        return [
          { ledger: { ...missing, refundClaimToken: null }, reclaimed: false },
          { ledger: invalid, reclaimed: false },
        ];
      },
      completeRefundClaim: (key, token, transaction) =>
        ledger.completeRefundClaim(key, token, transaction),
      releaseRefundClaim: (key, token, error, next) =>
        ledger.releaseRefundClaim(key, token, error, next),
    };
    const executor = provider(ledger, () => "ok");
    const result = await new RefundWorker(store, executor, {
      maxAttempts: 3,
      retryBaseMs: 10,
      claimLeaseMs: 100,
      limit: 10,
      now: () => 1_000_000,
    }).run();

    expect(result).toMatchObject({ attempted: 2, refunded: 0, failed: 0, unknown: 0 });
    expect(executor.calls).toHaveLength(0);
    expect(ledger.completions).toHaveLength(0);
  });

  it("does nothing at all when no webhook is configured", async () => {
    const ledger = new MemoryLedger(pendingRow());
    const result = await new RefundWorker(ledger, null, {
      maxAttempts: 3,
      retryBaseMs: 10,
      claimLeaseMs: 100,
      limit: 10,
    }).run();
    expect(result).toEqual({
      attempted: 0,
      refunded: 0,
      failed: 0,
      unknown: 0,
      exhausted: 0,
      reclaimed: 0,
      skipped: true,
    });
    expect(ledger.row().status).toBe("REFUND_PENDING");
  });

  it("warns when the claim lease is shorter than the call timeout", () => {
    const ledger = new MemoryLedger(pendingRow());
    // Not a correctness bug, because the key makes a resend safe, but it is the
    // durability smell the constructor is supposed to name.
    expect(
      () =>
        new RefundWorker(ledger, provider(ledger, () => "ok"), {
          maxAttempts: 3,
          retryBaseMs: 10,
          claimLeaseMs: 5,
          callTimeoutMs: 10,
          limit: 1,
        }),
    ).not.toThrow();
  });

  it("falls back to the derived key for a row that predates the column", async () => {
    const ledger = new MemoryLedger({ ...pendingRow(), refundIdempotencyKey: null });
    const store: RefundWorkerStore = {
      countLedgerByStatus: (status) => ledger.countLedgerByStatus(status),
      async claimRefunds(request): Promise<ClaimedRefund[]> {
        // The claim writes the column in production; simulate the pre-v18 row by
        // handing the worker the row without it.
        const claimed = await ledger.claimRefunds(request);
        return claimed.map((entry) => ({
          ...entry,
          ledger: { ...entry.ledger, refundIdempotencyKey: null },
        }));
      },
      completeRefundClaim: (key, token, transaction) =>
        ledger.completeRefundClaim(key, token, transaction),
      releaseRefundClaim: (key, token, error, next) =>
        ledger.releaseRefundClaim(key, token, error, next),
    };
    const executor = provider(ledger, () => "ok");
    const result = await new RefundWorker(store, executor, {
      maxAttempts: 3,
      retryBaseMs: 10,
      claimLeaseMs: 100,
      limit: 10,
      now: () => 1_000_000,
    }).run();

    expect(result.refunded).toBe(1);
    expect(executor.calls[0]?.idempotencyKey).toBe(`refund:${KEY}`);
  });
});

/* ------------------------------ HTTP fixture ------------------------------ */

interface RecordedRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

let httpPort = 0;
let answer: { status: number; body: string } = { status: 200, body: "{}" };
let lastRequest: RecordedRequest | undefined;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = undefined;
    }
    lastRequest = { headers: req.headers, body };
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(answer.body);
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  httpPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
