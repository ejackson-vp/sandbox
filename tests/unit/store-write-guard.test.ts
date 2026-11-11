/**
 * The single-writer backstop.
 *
 * Leadership decides who reconciles; this makes sure a write that slips past the
 * scheduler on a follower fails instead of diverging from the leader's state.
 * The guard is one `PRAGMA query_only` on the store connection, so it has to
 * cover every write path: the session statements, the payment repository and
 * the reservation repository.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../controller/src/store.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "x402-write-guard-"));
  dirs.push(dir);
  return new Store(join(dir, "controller.db"));
}

describe("store write guard", () => {
  it("refuses session, payment and reservation writes while a standby", () => {
    const store = tempStore();
    try {
      store.setWritesBlocked(true);
      expect(store.writesAreBlocked).toBe(true);

      // Session statements (Store.stmts).
      expect(() => store.requestDestroy("sbx_missing")).toThrow(/readonly/i);
      expect(() => store.markRefundPending("pay_missing", "x")).toThrow(/readonly/i);
      // Payment repository (its own prepared statements).
      expect(() => store.claimPaymentIntent("pay_1", "hash", 60_000)).toThrow(/readonly/i);
      // Reservation repository (its own prepared statements).
      expect(() => store.reservations.reapExpiredHolds(Date.now())).toThrow(/readonly/i);
    } finally {
      store.close();
    }
  });

  it("still serves reads while a standby", () => {
    const store = tempStore();
    try {
      store.setWritesBlocked(true);
      expect(store.getSession("sbx_missing")).toBeNull();
      expect(store.countSessions()).toBe(0);
      expect(store.listDue(Date.now(), 10)).toEqual([]);
      expect(store.stats().sizeBytes).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("reports a standby connection as read_only rather than a broken store", () => {
    const store = tempStore();
    try {
      expect(store.healthCheck()).toMatchObject({ ok: true });
      store.setWritesBlocked(true);
      expect(store.healthCheck()).toMatchObject({ ok: false, reason: "read_only" });
      // The probe must not leave a transaction open behind it: the same
      // connection has to accept writes the moment the lease is won.
      store.setWritesBlocked(false);
      expect(store.healthCheck()).toMatchObject({ ok: true });
    } finally {
      store.close();
    }
  });

  it("writes again after leadership is acquired", () => {
    const store = tempStore();
    try {
      store.setWritesBlocked(true);
      store.setWritesBlocked(false);
      expect(store.writesAreBlocked).toBe(false);

      const claim = store.claimPaymentIntent("pay_1", "hash", 60_000);
      expect(claim).toMatchObject({ status: "claimed" });
      // A blocking probe in between must not leave a transaction open either.
      store.setWritesBlocked(true);
      store.healthCheck();
      store.setWritesBlocked(false);
      expect(store.failPaymentIntent("pay_1", "cancelled")).toBeUndefined();
      expect(store.getPaymentIntent("pay_1")).toMatchObject({ status: "failed" });
    } finally {
      store.close();
    }
  });
});
