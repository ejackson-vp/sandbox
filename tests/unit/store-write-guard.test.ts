/**
 * The writer guard.
 *
 * Postgres carries it with a session advisory lock, so a standby is a store
 * that does not hold the lock: every write is a loud refusal and every read
 * still works. Leadership is taken and surrendered through `setWritesBlocked`,
 * which is the same boundary the controller's lease uses.
 */
import { describe, expect, it } from "vitest";
import { WriterLockUnavailableError } from "../../controller/src/store/postgres/pg.js";
import { countRows, freshStore } from "../helpers/test-store.js";

const REFUSED = /writer lock/i;

describe("store write guard", () => {
  it("refuses session, payment and reservation writes while a standby", async () => {
    const store = await freshStore();
    try {
      await store.setWritesBlocked(true);
      expect(store.writesAreBlocked).toBe(true);

      await expect(store.requestDestroy("sbx_missing")).rejects.toThrow(REFUSED);
      await expect(store.markRefundPending("pay_missing", "x")).rejects.toThrow(REFUSED);
      await expect(store.claimPaymentIntent("pay_1", "hash", 60_000)).rejects.toThrow(REFUSED);
      await expect(store.reservations.reapExpiredHolds(Date.now())).rejects.toThrow(REFUSED);
    } finally {
      await store.setWritesBlocked(false);
    }
  });

  it("still serves reads while a standby", async () => {
    const store = await freshStore();
    try {
      await store.setWritesBlocked(true);
      expect(await store.getSession("sbx_missing")).toBeNull();
      expect(await countRows("sessions")).toBe(0);
      expect(await store.listDue(Date.now(), 10)).toEqual([]);
      expect((await store.stats()).sizeBytes).toBeGreaterThan(0);
    } finally {
      await store.setWritesBlocked(false);
    }
  });

  it("reports a standby connection as read_only rather than a broken store", async () => {
    const store = await freshStore();
    try {
      expect(await store.healthCheck()).toMatchObject({ ok: true });
      await store.setWritesBlocked(true);
      expect(await store.healthCheck()).toMatchObject({ ok: false, reason: "read_only" });
      await store.setWritesBlocked(false);
      expect(await store.healthCheck()).toMatchObject({ ok: true });
    } finally {
      await store.setWritesBlocked(false);
    }
  });

  it("writes again after leadership is acquired", async () => {
    const store = await freshStore();
    try {
      await store.setWritesBlocked(true);
      await store.setWritesBlocked(false);
      expect(store.writesAreBlocked).toBe(false);

      const claim = await store.claimPaymentIntent("pay_1", "hash", 60_000);
      expect(claim).toMatchObject({ status: "claimed" });
      // A probe in between must not leave a transaction open either.
      await store.setWritesBlocked(true);
      await store.healthCheck();
      await store.setWritesBlocked(false);
      expect(await store.failPaymentIntent("pay_1", "cancelled")).toBeUndefined();
      expect(await store.getPaymentIntent("pay_1")).toMatchObject({ status: "failed" });
    } finally {
      await store.setWritesBlocked(false);
    }
  });

  it("names the lock refusal, not a generic failure", async () => {
    const store = await freshStore();
    await store.setWritesBlocked(true);
    try {
      await expect(store.claimPaymentIntent("pay_2", "hash", 60_000)).rejects.toThrow(
        WriterLockUnavailableError,
      );
    } finally {
      await store.setWritesBlocked(false);
    }
  });
});
