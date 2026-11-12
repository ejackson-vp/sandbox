/**
 * Due-time scheduling: one bounded pass dispatches only due sessions, and a
 * processed session is moved forward so the next pass cannot select it again.
 *
 * These use the real store (on the test database) so the interaction with the
 * state-changing statements is exercised, with a fake provisioner/relay and an
 * injected clock so "two consecutive passes" really are the same instant.
 */
import { describe, expect, it, vi } from "vitest";
import { metrics } from "@x402s/shared/runtime";
import { loadControllerConfig } from "../../controller/src/config.js";
import { Reconciler } from "../../controller/src/reconciler.js";
import { cadenceFor, DEFAULT_REDUE_INTERVAL_MS } from "../../controller/src/reconcile-cadence.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type { PaymentRecord, SessionRecord } from "../../controller/src/store.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import type { SessionLimits } from "../../shared/src/entries/protocol.js";
import { limitsFor, paymentFixture, sessionFixture } from "../helpers/store-fixtures.js";
import {
  freshStore,
  readNextDue as readStoredNextDue,
  setNextDue,
  testDatabaseUrl,
} from "../helpers/test-store.js";

const ADMIN = "unit-admin-token-0123456789";

function config(extra: Record<string, string> = {}) {
  return loadControllerConfig({
    ADMIN_TOKEN: ADMIN,
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DATABASE_URL: testDatabaseUrl(),
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
    RECONCILE_CONCURRENCY: "8",
    ...extra,
  });
}

const limits: SessionLimits = limitsFor("unit");

function paymentRecord(key: string): PaymentRecord {
  return paymentFixture({
    paymentKey: key,
    network: "mock:local",
    payer: "0x0000000000000000000000000000000000000001",
    transaction: "mock:tx",
  });
}

function sessionRecord(id: string, key: string): SessionRecord {
  return sessionFixture({
    id,
    paymentKey: key,
    // One client key pair per session: a repeated pair is a duplicate charge
    // and is refused by completeEntitlement (#31).
    clientPublicKey: `pk-${id}`,
    clientNonce: `nonce-${id}`,
    tier: "standard",
    durationSeconds: 300,
    limits,
    overrides: { idlePolicyJson: "{}", maxLifetimeSeconds: 28_800 },
  });
}

async function seedPaid(store: PostgresStore, id: string, keyChar: string): Promise<void> {
  const key = keyChar.repeat(64);
  const claim = await store.claimPaymentIntent(key, "a".repeat(64), 30_000);
  if (claim.status !== "claimed") throw new Error("expected claim");
  await store.completeEntitlement(key, claim.token, paymentRecord(key), sessionRecord(id, key));
}

/** A session parked in SUSPENDING, ready to be finished by a pass. */
async function seedSuspending(store: PostgresStore, id: string, keyChar: string): Promise<void> {
  await seedPaid(store, id, keyChar);
  if (!await store.setProvisioning(id, `pod-${id}`)) throw new Error("expected PROVISIONING");
  await store.setRelayToken(id, "relay-hash");
  const now = Date.now();
  if (!await store.setReady(id, now, now + 60_000, "{}", "guest-pk")) throw new Error("expected READY");
  if (!await store.markSuspending(id)) throw new Error("expected SUSPENDING");
}

const readNextDue = (id: string) => readStoredNextDue(id);

function harness(cfg: ReturnType<typeof config>, store: PostgresStore, clock: { now: number }) {
  const provisioner = { deletePod: vi.fn(async () => undefined) } as unknown as Provisioner;
  const relay = { isReady: async () => true } as unknown as RelayClient;
  const reconciler = new Reconciler({
    cfg,
    store,
    provisioner,
    relay,
    now: () => clock.now,
  });
  const provisioning = (
    reconciler as unknown as {
      provisioning: { provision: (s: SessionRecord) => Promise<void> };
    }
  ).provisioning;
  return { reconciler, provisioning };
}

describe("due-time reconcile pass", () => {
  it("dispatches a due session once and strictly advances its due time", async () => {
    const store = await freshStore();
    try {
      await seedPaid(store, "sbx_rearm", "a");
      const clock = { now: Date.now() };
      // Park the schedule in the past: this pass must pick it up.
      expect(await setNextDue("sbx_rearm", clock.now)).toBe(true);

      const { reconciler, provisioning } = harness(config(), store, clock);
      const provision = vi.fn(async () => undefined);
      provisioning.provision = provision;

      await reconciler.tick();
      expect(provision).toHaveBeenCalledTimes(1);
      const firstDue = await readNextDue("sbx_rearm");
      expect(firstDue).not.toBeNull();
      expect(firstDue!).toBeGreaterThan(clock.now);
      // Nothing consumes the schedule between two ticks at the same instant.
      expect((await store.listDue(clock.now, 10)).map((s) => s.id)).not.toContain("sbx_rearm");

      await reconciler.tick();
      expect(provision).toHaveBeenCalledTimes(1);
      expect(await readNextDue("sbx_rearm")).toBe(firstDue);

      // At its due time it is dispatched again (not starved) and moves further.
      clock.now = firstDue!;
      await reconciler.tick();
      expect(provision).toHaveBeenCalledTimes(2);
      expect((await readNextDue("sbx_rearm"))!).toBeGreaterThan(firstDue!);
    } finally {
      await store.close();
    }
  });

  it("does not overwrite a due time a state transition already armed", async () => {
    const store = await freshStore();
    try {
      await seedSuspending(store, "sbx_transition", "b");
      const clock = { now: Date.now() };
      expect(await setNextDue("sbx_transition", clock.now)).toBe(true);

      const { reconciler } = harness(config(), store, clock);
      // The real finishSuspend is stubbed at the seam so the pass performs the
      // SUSPENDING -> SUSPENDED write (cadence 15s), not a rebuild of it.
      (
        reconciler as unknown as {
          lifecycle: { finishSuspend: (s: SessionRecord) => Promise<void> };
        }
      ).lifecycle.finishSuspend = async (s) => {
        expect(await store.markSuspended(s.id, Date.now())).toBe(true);
      };

      const before = Date.now();
      await reconciler.tick();
      expect((await store.getSession("sbx_transition"))?.state).toBe("SUSPENDED");

      const due = await readNextDue("sbx_transition");
      expect(due).not.toBeNull();
      // The transition's SUSPENDED cadence survives: a re-arm from the
      // pre-pass SUSPENDING state (500ms) would have shortened it.
      expect(due!).toBeGreaterThanOrEqual(before + cadenceFor("SUSPENDED") - 500);

      // A future deadline is never pulled forward by a later re-arm attempt.
      expect(await store.rearmDue("sbx_transition", clock.now + 1, clock.now)).toBe(false);
      expect(await readNextDue("sbx_transition")).toBe(due);
    } finally {
      await store.close();
    }
  });

  it("bounds one pass by the budget and reports the untouched backlog", async () => {
    const store = await freshStore();
    try {
      const ids = ["sbx_b1", "sbx_b2", "sbx_b3"];
      for (const [i, id] of ids.entries()) {
        await seedPaid(store, id, String.fromCharCode(99 + i));
      }
      const clock = { now: Date.now() };
      for (const id of ids) expect(await setNextDue(id, clock.now)).toBe(true);

      const { reconciler, provisioning } = harness(
        config({ RECONCILE_BUDGET: "2" }),
        store,
        clock,
      );
      const provision = vi.fn(async () => undefined);
      provisioning.provision = provision;

      await reconciler.tick();
      expect(provision).toHaveBeenCalledTimes(2);
      // The third row is still due for the next pass, not lost.
      expect((await store.listDue(clock.now, 10)).map((s) => s.id)).toEqual(["sbx_b3"]);

      // The registry caches rendered text for 500ms; wait it out.
      await new Promise((resolve) => setTimeout(resolve, 520));
      const text = metrics.render();
      expect(text).toContain("sandbox_reconcile_due_backlog 1");
      expect(text).toContain("sandbox_reconcile_saturated 0");
    } finally {
      await store.close();
    }
  });

  it("makes a destroy request immediately due, even from a long cadence", async () => {
    const store = await freshStore();
    try {
      await seedPaid(store, "sbx_destroy", "f");
      const clock = { now: Date.now() };
      expect(await setNextDue("sbx_destroy", clock.now + cadenceFor("SUSPENDED"))).toBe(true);
      expect(await store.listDue(clock.now, 10)).toEqual([]);

      await store.requestDestroy("sbx_destroy");
      expect((await store.listDue(Date.now(), 10)).map((s) => s.id)).toEqual(["sbx_destroy"]);
    } finally {
      await store.close();
    }
  });
});

describe("reconcile cadence policy", () => {
  it("enumerates every non-terminal state with an ordered cadence", async () => {
    // Provisioning is latency-critical; steady-state and suspended are not.
    expect(cadenceFor("PROVISIONING")).toBeLessThanOrEqual(250);
    expect(cadenceFor("RESUMING")).toBeLessThanOrEqual(250);
    expect(cadenceFor("READY")).toBeGreaterThan(cadenceFor("PROVISIONING"));
    expect(cadenceFor("ACTIVE")).toBeGreaterThan(cadenceFor("PROVISIONING"));
    expect(cadenceFor("SUSPENDED")).toBeGreaterThan(cadenceFor("READY"));
    // Terminal states are outside the table and fall back, not throw.
    expect(cadenceFor("EXPIRED")).toBe(DEFAULT_REDUE_INTERVAL_MS);
  });
});
