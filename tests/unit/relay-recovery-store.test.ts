/**
 * Store half of relay generation recovery.
 *
 * `listRelaySessions` is the scan set (READY/ACTIVE with a credential and a
 * Pod), and `recoverSessionOperation` must be exactly once: the
 * `pending -> outcome_unknown` transition is the guard, so a repeated scan
 * cannot bump `exec_epoch` twice. Both are asserted against real Postgres
 * because the guarantee is the statement, not the caller.
 */
import { describe, expect, it } from "vitest";
import type { SessionLimits } from "@x402s/shared/protocol";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { freshStore } from "../helpers/test-store.js";
import { paymentFixture, sessionFixture } from "../helpers/store-fixtures.js";

const limits: SessionLimits = {
  cpuMillis: 500,
  memoryMiB: 512,
  diskMiB: 256,
  maxOutputBytes: 262_144,
  maxFileBytes: 8 * 1024 * 1024,
  maxCommandSeconds: 120,
  maxProcesses: 256,
};

async function seed(
  store: PostgresStore,
  id: string,
  opts: { ready?: boolean; tokenHash?: string | null; pod?: string | null } = {},
): Promise<void> {
  const key = id.slice(-8).padEnd(64, "0");
  const claim = await store.claimPaymentIntent(key, `relay-recovery-${id}`, 30_000);
  if (claim.status !== "claimed") throw new Error(`expected claim, got ${claim.status}`);
  await store.completeEntitlement(
    key,
    claim.token,
    paymentFixture({ paymentKey: key, network: "mock:local" }),
    sessionFixture({
      id,
      paymentKey: key,
      tier: "custom",
      durationSeconds: 300,
      limits,
      // One client key pair owns one session, so each fixture needs its own.
      clientPublicKey: `pk-${id}`,
      clientNonce: `nonce-${id}`,
    }),
  );
  const pod = opts.pod === undefined ? `pod-${id}` : opts.pod;
  if (pod) await store.setProvisioning(id, pod);
  if (opts.tokenHash !== null) await store.setRelayToken(id, opts.tokenHash ?? "h".repeat(64));
  if (opts.ready !== false) {
    await store.setReady(id, Date.now(), Date.now() + 300_000, "{}", "guestpk");
  }
}

describe("relay recovery store", () => {
  it("scans READY/ACTIVE sessions that have a credential and a Pod", async () => {
    const store = await freshStore();
    try {
      const ready = "sbx_relay_ready_0001";
      const active = "sbx_relay_activ_0001";
      const paid = "sbx_relay_paid_00001";
      const noCredential = "sbx_relay_nocred_0001";
      const noPod = "sbx_relay_nopod_0001";
      await seed(store, ready);
      await seed(store, active);
      await seed(store, paid, { ready: false });
      await seed(store, noCredential, { tokenHash: null });
      await seed(store, noPod, { pod: null });

      // ACTIVE is the same gate with an operation running.
      expect(await store.claimOperation(active, "relay-recovery-active-op", "exec")).toMatchObject({
        ok: true,
      });

      const scanned = (await store.listRelaySessions(100)).map((session) => session.id).sort();
      expect(scanned).toEqual([active, ready].sort());

      // Paging by id: the relay scan must cover a set larger than one page, so
      // the cursor must be a strict "after" and the order must be stable.
      const [firstId, secondId] = [active, ready].sort();
      const page1 = await store.listRelaySessions(1);
      expect(page1.map((session) => session.id)).toEqual([firstId]);
      const page2 = await store.listRelaySessions(1, firstId);
      expect(page2.map((session) => session.id)).toEqual([secondId]);
      expect(await store.listRelaySessions(1, secondId)).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("fences the in-flight request exactly once and leaves a fenced row alone", async () => {
    const store = await freshStore();
    try {
      const id = "sbx_relay_fence_0001";
      await seed(store, id);
      expect(await store.claimOperation(id, "relay-recovery-old-op", "exec")).toMatchObject({
        ok: true,
        epoch: 1,
      });

      expect(await store.recoverSessionOperation(id)).toEqual({
        requestId: "relay-recovery-old-op",
        epoch: 2,
      });
      expect(await store.getExecRequest(id, "relay-recovery-old-op")).toMatchObject({
        state: "outcome_unknown",
        epoch: 1,
        resultEnvelope: null,
      });
      expect(await store.getSession(id)).toMatchObject({
        activeRequestId: "relay-recovery-old-op",
        execEpoch: 2,
      });

      // A second scan of the same session changes nothing: the pending ->
      // outcome_unknown transition already happened.
      expect(await store.recoverSessionOperation(id)).toEqual({ requestId: null, epoch: null });
      expect(await store.getSession(id)).toMatchObject({ execEpoch: 2 });
    } finally {
      await store.close();
    }
  });

  it("does nothing for an idle session and never fences a completed operation", async () => {
    const store = await freshStore();
    try {
      const idle = "sbx_relay_idle_00001";
      await seed(store, idle);
      expect(await store.recoverSessionOperation(idle)).toEqual({ requestId: null, epoch: null });
      expect((await store.getSession(idle))?.execEpoch).toBe(1);

      const done = "sbx_relay_done_00001";
      await seed(store, done);
      expect(await store.claimOperation(done, "relay-recovery-done-op", "exec")).toMatchObject({ ok: true });
      await store.finishOperation(done, "relay-recovery-done-op", "done", "sealed-result");
      expect(await store.recoverSessionOperation(done)).toEqual({ requestId: null, epoch: null });
      expect(await store.getExecRequest(done, "relay-recovery-done-op")).toMatchObject({
        state: "done",
        resultEnvelope: "sealed-result",
      });
      expect((await store.getSession(done))?.execEpoch).toBe(1);
    } finally {
      await store.close();
    }
  });
});
