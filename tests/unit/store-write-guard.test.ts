import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../controller/src/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "x402-guard-"));
  dirs.push(dir);
  return new Store(join(dir, "controller.db"));
}

describe("store write guard", () => {
  it("refuses session, payment and reservation writes while a standby", async () => {
    const store = tempStore();
    try {
      store.setWritesBlocked(true);
      expect(store.writesAreBlocked).toBe(true);

      // Session statements (Store.stmts). The port methods are async, so the
      // guard surfaces as a rejection, not a synchronous throw: every caller
      // awaits, and that is the shape a network adapter can also produce.
      await expect(store.requestDestroy("sbx_missing")).rejects.toThrow(/readonly/i);
      await expect(store.markRefundPending("pay_missing", "x")).rejects.toThrow(/readonly/i);
      // Payment repository (its own prepared statements).
      await expect(store.claimPaymentIntent("pay_1", "hash", 60_000)).rejects.toThrow(/readonly/i);
      // Reservation repository (its own prepared statements).
      await expect(store.reservations.reapExpiredHolds(Date.now())).rejects.toThrow(/readonly/i);
    } finally {
      store.close();
    }
  });

  it("still serves reads while a standby", async () => {
    const store = tempStore();
    try {
      store.setWritesBlocked(true);
      expect(await store.getSession("sbx_missing")).toBeNull();
      expect(store.countSessions()).toBe(0);
      expect(await store.listDue(Date.now(), 10)).toEqual([]);
      expect((await store.stats()).sizeBytes).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("reports a standby connection as read_only rather than a broken store", async () => {
    const store = tempStore();
    try {
      expect(await store.healthCheck()).toMatchObject({ ok: true });
      store.setWritesBlocked(true);
      expect(await store.healthCheck()).toMatchObject({ ok: false, reason: "read_only" });
      // The probe must not leave a transaction open behind it: the same
      // connection has to accept writes the moment the lease is won.
      store.setWritesBlocked(false);
      expect(await store.healthCheck()).toMatchObject({ ok: true });
    } finally {
      store.close();
    }
  });

  it("writes again after leadership is acquired", async () => {
    const store = tempStore();
    try {
      store.setWritesBlocked(true);
      store.setWritesBlocked(false);
      expect(store.writesAreBlocked).toBe(false);

      const claim = await store.claimPaymentIntent("pay_1", "hash", 60_000);
      expect(claim).toMatchObject({ status: "claimed" });
      // A blocking probe in between must not leave a transaction open either.
      store.setWritesBlocked(true);
      await store.healthCheck();
      store.setWritesBlocked(false);
      expect(await store.failPaymentIntent("pay_1", "cancelled")).toBeUndefined();
      expect(await store.getPaymentIntent("pay_1")).toMatchObject({ status: "failed" });
    } finally {
      store.close();
    }
  });
});
