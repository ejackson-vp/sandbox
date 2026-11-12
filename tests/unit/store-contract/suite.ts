/**
 * The store contract: invariants that must hold on every backend.
 *
 * Written once and run against SQLite and Postgres so a divergence is a failed
 * test rather than a production surprise. The concurrency tests issue real
 * concurrent calls: on SQLite that is two connections on one file serialised by
 * `BEGIN IMMEDIATE`, on Postgres it is two pool connections under
 * `READ COMMITTED`. The assertions are about outcomes (one row, one refusal,
 * one gate holder), not about how the backend got there.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME } from "@x402s/shared/runtimes";
import { DuplicateEntitlementError, PaymentClaimLostError } from "../../../controller/src/store.js";
import type { StoreBackend } from "../../../controller/src/store/backend.js";
import type { BudgetLimits } from "../../../controller/src/store/budgets.js";
import {
  capacitySnapshot,
  paymentRecord,
  RESOURCE_REQUEST,
  seedReadySession,
  seedSession,
  sessionRecord,
  type ContractBackend,
} from "./fixtures.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_C = "c".repeat(64);
const SPEC = "f".repeat(64);
const SESSION_1 = `sbx_${"1".repeat(24)}`;
const SESSION_2 = `sbx_${"2".repeat(24)}`;
const SESSION_3 = `sbx_${"3".repeat(24)}`;

export function describeStoreContract(backend: ContractBackend): void {
  describe(`store contract (${backend.label})`, () => {
    let store: StoreBackend;

    beforeEach(async () => {
      await backend.reset();
      store = await backend.open();
    });

    afterAll(async () => {
      await backend.close();
    });

    it("is migrated and accepts a write", async () => {
      const health = await store.healthCheck();
      expect(health.ok).toBe(true);
    });

    it("settles concurrent completions into one payment and one session", async () => {
      const claim = await store.claimPaymentIntent(KEY_A, SPEC, 30_000);
      if (claim.status !== "claimed") throw new Error(`claim was ${claim.status}`);

      const ids = Array.from({ length: 4 }, (_, i) => `sbx_${"9".repeat(23)}${i}`);
      const results = await Promise.all(
        ids.map((id) =>
          store.completeEntitlement(KEY_A, claim.token, paymentRecord(KEY_A), sessionRecord(id, KEY_A)),
        ),
      );

      const created = results.filter((r) => r.created);
      const idempotent = results.filter((r) => !r.created);
      expect(created).toHaveLength(1);
      expect(idempotent).toHaveLength(3);
      const winner = created[0]!.sessionId;
      for (const row of idempotent) expect(row.sessionId).toBe(winner);

      // One payments row, one sessions row, both keyed by the same payment key.
      expect(await store.getPayment(KEY_A)).not.toBeNull();
      const live = await store.listNonTerminal();
      expect(live.map((s) => s.id)).toEqual([winner]);
      expect(live[0]!.paymentKey).toBe(KEY_A);
      expect((await store.getLedgerBySession(winner))?.status).toBe("SETTLED");
      expect(await store.getPaymentIntent(KEY_A)).toMatchObject({
        status: "settled",
        sessionId: winner,
        claimToken: null,
      });
    });

    it("refuses a claim token that has been reclaimed", async () => {
      const first = await store.claimPaymentIntent(KEY_A, SPEC, 30_000);
      if (first.status !== "claimed") throw new Error(`claim was ${first.status}`);

      const reclaimed = await store.claimPaymentIntent(KEY_A, SPEC, -1);
      expect(reclaimed.status).toBe("claimed");
      if (reclaimed.status !== "claimed") return;
      expect(reclaimed.recovered).toBe(true);
      expect(reclaimed.token).not.toBe(first.token);

      await expect(
        store.completeEntitlement(KEY_A, first.token, paymentRecord(KEY_A), sessionRecord(SESSION_1, KEY_A)),
      ).rejects.toThrow(PaymentClaimLostError);

      // Nothing was written by the stale owner.
      expect(await store.getPayment(KEY_A)).toBeNull();
      expect(await store.listNonTerminal()).toHaveLength(0);
      expect((await store.getPaymentIntent(KEY_A))?.status).toBe("claimed");
    });

    it("refuses a second session for the same client key pair, and refunds it", async () => {
      const nonce = "shared-client-nonce";
      await seedSession(store, SESSION_1, KEY_A, nonce);

      const claim = await store.claimPaymentIntent(KEY_B, SPEC, 30_000);
      if (claim.status !== "claimed") throw new Error(`claim was ${claim.status}`);
      await expect(
        store.completeEntitlement(KEY_B, claim.token, paymentRecord(KEY_B), sessionRecord(SESSION_2, KEY_B, nonce)),
      ).rejects.toThrow(DuplicateEntitlementError);

      expect(await store.getPayment(KEY_B)).not.toBeNull();
      const ledger = await store.getLedgerByPayment(KEY_B);
      expect(ledger?.sessionId).toBe(`duplicate:${KEY_B}`);
      expect(["REFUNDED", "REFUND_PENDING"]).toContain(ledger?.status);
      expect(await store.listNonTerminal()).toHaveLength(1);
      expect((await store.getPaymentIntent(KEY_B))?.status).toBe("failed");
    });

    it("lets exactly one concurrent setReady win", async () => {
      await seedSession(store, SESSION_1, KEY_A);
      expect(await store.setProvisioning(SESSION_1, "pod-1")).toBe(true);
      // No relay token yet: the guard requires one, so READY must be refused.
      expect(await store.setReady(SESSION_1, Date.now(), Date.now() + 60_000, "{}", "g")).toBe(false);
      await store.setRelayToken(SESSION_1, "relay-token");

      const now = Date.now();
      const results = await Promise.all([
        store.setReady(SESSION_1, now, now + 60_000, "{}", "guest-key"),
        store.setReady(SESSION_1, now, now + 60_000, "{}", "guest-key"),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await store.getSession(SESSION_1))?.state).toBe("READY");
    });

    it("finalizes a termination exactly once", async () => {
      await seedSession(store, SESSION_1, KEY_A);
      expect(await store.requestTermination(SESSION_1, "client_destroy")).toBe(true);
      // A second request from a non-TERMINATING row is refused.
      expect(await store.requestTermination(SESSION_1, "client_destroy")).toBe(false);

      const results = await Promise.all([
        store.finalizeTermination(SESSION_1),
        store.finalizeTermination(SESSION_1),
      ]);
      const finals = results.filter((state) => state !== null);
      expect(finals).toHaveLength(1);
      expect(finals[0]).toBe("DESTROYED");
      expect(await store.finalizeTermination(SESSION_1)).toBeNull();
      expect((await store.getSession(SESSION_1))?.state).toBe("DESTROYED");
    });

    it("records the failure code in the same termination decision", async () => {
      await seedSession(store, SESSION_1, KEY_A);
      expect(
        await store.requestTermination(SESSION_1, "failure:provisioning_timeout", {
          code: "provisioning_timeout",
          message: "the pod never reported ready",
        }),
      ).toBe(true);

      const session = await store.getSession(SESSION_1);
      expect(session?.state).toBe("TERMINATING");
      expect(session?.failureCode).toBe("provisioning_timeout");
      expect(session?.failureMessage).toBe("the pod never reported ready");
    });

    it("defaults a missing runtime to the shared default on every backend", async () => {
      const key = "d".repeat(64);
      const record = sessionRecord(SESSION_1, key);
      delete record.runtime;

      const claim = await store.claimPaymentIntent(key, "a".repeat(64), 30_000);
      if (claim.status !== "claimed") throw new Error(`seed claim was ${claim.status}`);
      await store.completeEntitlement(key, claim.token, paymentRecord(key), record);

      expect((await store.getSession(SESSION_1))?.runtime).toBe(DEFAULT_RUNTIME);
    });

    it("gives the single operation slot to one of two concurrent claims", async () => {
      await seedReadySession(store, SESSION_1, KEY_A);

      const results = await Promise.all([
        store.claimOperation(SESSION_1, "req-1", "exec"),
        store.claimOperation(SESSION_1, "req-2", "exec"),
      ]);
      const granted = results.filter((r) => r.ok);
      expect(granted).toHaveLength(1);
      const refused = results.filter((r) => !r.ok);
      expect(refused[0]).toMatchObject({ code: "busy" });

      const winner = granted[0]!;
      if (!winner.ok) return;
      expect((await store.getSession(SESSION_1))?.activeRequestId).toBe(winner.requestId);
      expect((await store.getSession(SESSION_1))?.state).toBe("ACTIVE");

      await store.finishOperation(SESSION_1, winner.requestId, "done");
      expect((await store.getSession(SESSION_1))?.activeRequestId).toBeNull();
      const next = await store.claimOperation(SESSION_1, "req-3", "exec");
      expect(next.ok).toBe(true);
    });

    it("stores one exec_request for two concurrent claims of the same request id", async () => {
      await seedReadySession(store, SESSION_1, KEY_A);

      const results = await Promise.all([
        store.claimOperation(SESSION_1, "same-request", "exec"),
        store.claimOperation(SESSION_1, "same-request", "exec"),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(1);

      // PRIMARY KEY (session_id, id): one row, whichever path wrote it.
      const request = await store.getExecRequest(SESSION_1, "same-request");
      expect(request).not.toBeNull();
      expect(request?.state).toBe("pending");
      expect((await store.getSession(SESSION_1))?.activeRequestId).toBe("same-request");
    });

    it("treats a retry of the same request id and payload as idempotent", async () => {
      await seedReadySession(store, SESSION_1, KEY_A);
      const payload = "a".repeat(64);

      expect(await store.claimOperation(SESSION_1, "retry-same", "exec", payload)).toMatchObject({
        ok: true,
      });
      await store.finishOperation(SESSION_1, "retry-same", "done");

      // Second claim of the same request id and payload: no second execution,
      // no new epoch, just the duplicate signal the control API turns into the
      // cached result.
      expect(await store.claimOperation(SESSION_1, "retry-same", "exec", payload)).toMatchObject({
        ok: false,
        code: "duplicate",
        requestId: "retry-same",
      });
      expect((await store.getExecRequest(SESSION_1, "retry-same"))?.payloadHash).toBe(payload);
    });

    it("refuses a retry that reuses the request id for a different payload", async () => {
      await seedReadySession(store, SESSION_1, KEY_A);

      expect(
        await store.claimOperation(SESSION_1, "retry-different", "exec", "b".repeat(64)),
      ).toMatchObject({ ok: true });
      await store.finishOperation(SESSION_1, "retry-different", "done");

      expect(
        await store.claimOperation(SESSION_1, "retry-different", "file.put", "c".repeat(64)),
      ).toMatchObject({ ok: false, code: "idempotency_key_reused", requestId: "retry-different" });

      // The stored row still names the first payload; the second is never run.
      const record = await store.getExecRequest(SESSION_1, "retry-different");
      expect(record?.op).toBe("exec");
      expect(record?.payloadHash).toBe("b".repeat(64));
    });

    it("accepts a duplicate against a row with no stored payload hash", async () => {
      await seedReadySession(store, SESSION_1, KEY_A);

      // A pre-v16 row has no hash. It cannot be verified, so any duplicate is
      // accepted (this is what keeps an in-flight request working across the
      // upgrade).
      expect(await store.claimOperation(SESSION_1, "legacy-row", "exec")).toMatchObject({ ok: true });
      await store.finishOperation(SESSION_1, "legacy-row", "done");
      expect((await store.getExecRequest(SESSION_1, "legacy-row"))?.payloadHash).toBeNull();

      expect(
        await store.claimOperation(SESSION_1, "legacy-row", "file.put", "d".repeat(64)),
      ).toMatchObject({ ok: false, code: "duplicate" });
    });

    it("gives a concurrently reused request id to one payload only", async () => {
      await seedReadySession(store, SESSION_1, KEY_A);

      const results = await Promise.all([
        store.claimOperation(SESSION_1, "retry-raced", "exec", "e".repeat(64)),
        store.claimOperation(SESSION_1, "retry-raced", "file.put", "f".repeat(64)),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const refused = results.filter((r) => !r.ok);
      expect(refused[0]).toMatchObject({ code: "idempotency_key_reused" });
      const record = await store.getExecRequest(SESSION_1, "retry-raced");
      expect(["e".repeat(64), "f".repeat(64)]).toContain(record?.payloadHash);
    });

    it("counts concurrent creates against the durable budget once", async () => {
      const limits: BudgetLimits = {
        windowMs: 3_600_000,
        payerCreates: 10,
        payerSpend: "1000000",
        payerConcurrent: 0,
        globalCreates: 1,
        globalConcurrent: 0,
      };
      const results = await Promise.all([
        store.reserveBudgets("0xpayer", "50000", limits),
        store.reserveBudgets("0xpayer", "50000", limits),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const refused = results.filter((r) => !r.ok);
      expect(refused[0]).toMatchObject({ ok: false, scope: "global_create" });
    });

    it("admits one reservation per payment and refuses the conflicting spec", async () => {
      const snapshot = capacitySnapshot();
      const results = await Promise.all([
        store.reservations.admit(snapshot, RESOURCE_REQUEST, {
          paymentKey: KEY_A,
          specHash: "1".repeat(64),
          state: "HELD",
        }),
        store.reservations.admit(snapshot, RESOURCE_REQUEST, {
          paymentKey: KEY_A,
          specHash: "2".repeat(64),
          state: "HELD",
        }),
      ]);
      expect(results.filter((r) => r.admitted)).toHaveLength(1);
      const refused = results.filter((r) => !r.admitted);
      expect(refused[0]).toMatchObject({ reason: "invalid_request", retryable: false });

      const active = await store.reservations.listActive();
      expect(active).toHaveLength(1);
      expect(active[0]!.paymentKey).toBe(KEY_A);
    });

    it("refuses writes while this process is not the writer", async () => {
      await store.setWritesBlocked(true);
      try {
        expect(store.writesAreBlocked).toBe(true);
        // Reads still work: a standby serves readiness and backups.
        expect(await store.getSession(SESSION_1)).toBeNull();
        await expect(store.claimPaymentIntent(KEY_A, SPEC, 30_000)).rejects.toThrow();
        const health = await store.healthCheck();
        expect(health.ok).toBe(false);
      } finally {
        await store.setWritesBlocked(false);
      }
      const claim = await store.claimPaymentIntent(KEY_A, SPEC, 30_000);
      expect(claim.status).toBe("claimed");
    });

    it("returns never-scheduled sessions ahead of scheduled ones", async () => {
      await seedSession(store, SESSION_1, KEY_A);
      await seedSession(store, SESSION_2, KEY_B);
      await seedSession(store, SESSION_3, KEY_C);
      const now = Date.now();

      // Both start NULL ("due now"). One is armed into the past, one into the
      // future; SESSION_2 is left untouched.
      expect(await store.rearmDue(SESSION_1, now - 5_000, now)).toBe(true);
      expect(await store.rearmDue(SESSION_3, now + 60_000, now)).toBe(true);
      // A future deadline is not re-armed by a pass at `now`.
      expect(await store.rearmDue(SESSION_3, now + 120_000, now)).toBe(false);

      const due = await store.listDue(now, 10);
      // NULL sorts first on both backends, then the past deadline. A backend
      // that sorted NULLs last would return only SESSION_1 here.
      expect(due.map((s) => s.id)).toEqual([SESSION_2, SESSION_1]);
    });
  });
}
