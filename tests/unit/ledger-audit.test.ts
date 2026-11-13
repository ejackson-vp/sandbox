/**
 * The ledger audit: every divergence reason, the clean case, and the gauges the
 * scrape path publishes.
 *
 * The pure table below is the contract. The Postgres test seeds one real
 * divergence and one stale session through the same store the controller uses,
 * then asserts what a scrape would expose, so the query predicates and the pure
 * rules cannot drift apart silently.
 */
import { describe, expect, it } from "vitest";
import { SESSION_STATES, TERMINAL_STATES } from "../../shared/src/entries/protocol.js";
import { MetricsRegistry } from "../../shared/src/metrics.js";
import {
  AUDIT_SESSION_PHASES,
  auditLedger,
  DEFAULT_LEDGER_AUDIT_LIMITS,
  isAuditSessionPhase,
  LEDGER_DIVERGENCE_REASONS,
  sessionDeadline,
  type IntentLedgerSnapshot,
  type LedgerAuditLimits,
  type LedgerDivergenceReason,
  type LiveRefundClaim,
  type SessionLifetimeSnapshot,
} from "../../controller/src/ledger-audit.js";
import { createLedgerAuditCollector } from "../../controller/src/ledger-audit-collector.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { limitsFor, paymentFixture, sessionFixture } from "../helpers/store-fixtures.js";
import { freshStore, sqlExec } from "../helpers/test-store.js";

const NOW = 1_700_000_000_000;
const LIMITS: LedgerAuditLimits = { sessionGraceMs: 60_000, maxRows: 100 };

function audit(partial: {
  intents?: readonly IntentLedgerSnapshot[];
  liveRefunds?: readonly LiveRefundClaim[];
  sessions?: readonly SessionLifetimeSnapshot[];
}) {
  return auditLedger(
    {
      intents: partial.intents ?? [],
      liveRefunds: partial.liveRefunds ?? [],
      sessions: partial.sessions ?? [],
    },
    LIMITS,
    NOW,
  );
}

describe("ledger audit", () => {
  it.each<{
    name: string;
    row: IntentLedgerSnapshot;
    expected: LedgerDivergenceReason[];
  }>([
    {
      name: "a settled intent with a settled ledger balances",
      row: { paymentKey: "k1", intentStatus: "settled", ledgerStatus: "SETTLED" },
      expected: [],
    },
    {
      name: "a settled intent with a refunded ledger is a refund, not a divergence",
      row: { paymentKey: "k1", intentStatus: "settled", ledgerStatus: "REFUNDED" },
      expected: [],
    },
    {
      name: "a settled intent with a pending refund is a refund in progress",
      row: { paymentKey: "k1", intentStatus: "settled", ledgerStatus: "REFUND_PENDING" },
      expected: [],
    },
    {
      name: "a settled intent with a sending refund is still a refund",
      row: { paymentKey: "k1", intentStatus: "settled", ledgerStatus: "REFUND_SENDING" },
      expected: [],
    },
    {
      name: "a settled intent with no ledger row diverges",
      row: { paymentKey: "k1", intentStatus: "settled", ledgerStatus: null },
      expected: ["settled_without_ledger"],
    },
    {
      name: "a failed intent with a settled ledger contradicts the refusal",
      row: { paymentKey: "k1", intentStatus: "failed", ledgerStatus: "SETTLED" },
      expected: ["intent_failed_ledger_settled"],
    },
    {
      name: "a failed intent with a refunded ledger is the duplicate-charge path",
      row: { paymentKey: "k1", intentStatus: "failed", ledgerStatus: "REFUNDED" },
      expected: [],
    },
    {
      name: "a failed intent with a pending refund is the real-mode duplicate path",
      row: { paymentKey: "k1", intentStatus: "failed", ledgerStatus: "REFUND_PENDING" },
      expected: [],
    },
    {
      name: "a claimed intent with a settled ledger is settlement recovery",
      row: { paymentKey: "k1", intentStatus: "claimed", ledgerStatus: "SETTLED" },
      expected: [],
    },
    {
      name: "a claimed intent with no ledger is a payment still in flight",
      row: { paymentKey: "k1", intentStatus: "claimed", ledgerStatus: null },
      expected: [],
    },
  ])("$name", ({ row, expected }) => {
    const result = audit({ intents: [row] });
    expect(result.divergences.map((finding) => finding.reason)).toEqual(expected);
    expect(result.divergences.every((finding) => finding.paymentKey === row.paymentKey)).toBe(true);
    for (const reason of LEDGER_DIVERGENCE_REASONS) {
      expect(result.divergenceCounts[reason]).toBe(expected.includes(reason) ? 1 : 0);
    }
  });

  it("counts every reason even when the books are clean", () => {
    const result = audit({});
    expect(Object.keys(result.divergenceCounts).sort()).toEqual([...LEDGER_DIVERGENCE_REASONS].sort());
    expect(Object.values(result.divergenceCounts)).toEqual(
      LEDGER_DIVERGENCE_REASONS.map(() => 0),
    );
    expect(Object.keys(result.staleCounts).sort()).toEqual([...AUDIT_SESSION_PHASES].sort());
    expect(Object.values(result.staleCounts)).toEqual(AUDIT_SESSION_PHASES.map(() => 0));
  });

  it("reports every payment key on a shared nonce as a duplicate live claim", () => {
    const result = audit({
      liveRefunds: [
        { paymentKey: "k1", settlementNonce: "0xnonce" },
        { paymentKey: "k2", settlementNonce: "0xnonce" },
      ],
    });
    expect(result.divergences).toEqual([
      { paymentKey: "k1", reason: "duplicate_refund_claim" },
      { paymentKey: "k2", reason: "duplicate_refund_claim" },
    ]);
    expect(result.divergenceCounts.duplicate_refund_claim).toBe(2);
  });

  it("does not call distinct nonces or a nonce-less claim a duplicate", () => {
    const result = audit({
      liveRefunds: [
        { paymentKey: "k1", settlementNonce: "0xone" },
        { paymentKey: "k2", settlementNonce: "0xtwo" },
        { paymentKey: "k3", settlementNonce: null },
      ],
    });
    expect(result.divergences).toEqual([]);
    expect(result.divergenceCounts.duplicate_refund_claim).toBe(0);
  });

  it("uses the lease deadline when the session reached READY", () => {
    const row: SessionLifetimeSnapshot = {
      sessionId: "s1",
      state: "READY",
      createdAt: NOW - 3_600_000,
      leaseExpiresAt: NOW - LIMITS.sessionGraceMs - 1,
      maxLifetimeSeconds: 1,
    };
    expect(sessionDeadline(row)).toBe(row.leaseExpiresAt);
    const result = audit({ sessions: [row] });
    expect(result.staleSessions).toEqual([
      { sessionId: "s1", phase: "READY", overdueMs: LIMITS.sessionGraceMs + 1 },
    ]);
    expect(result.staleCounts.READY).toBe(1);
  });

  it("leaves a session inside the grace window alone", () => {
    const result = audit({
      sessions: [
        {
          sessionId: "s1",
          state: "ACTIVE",
          createdAt: NOW - 3_600_000,
          leaseExpiresAt: NOW - LIMITS.sessionGraceMs,
          maxLifetimeSeconds: null,
        },
      ],
    });
    expect(result.staleSessions).toEqual([]);
    expect(result.staleCounts.ACTIVE).toBe(0);
  });

  it("falls back to the wall-clock lifetime for a session that never got ready", () => {
    const stale = audit({
      sessions: [
        {
          sessionId: "s1",
          state: "PAID",
          createdAt: NOW - 180_000,
          leaseExpiresAt: null,
          maxLifetimeSeconds: 60,
        },
      ],
    });
    expect(stale.staleSessions.map((session) => session.phase)).toEqual(["PAID"]);
    expect(stale.staleCounts.PAID).toBe(1);

    const young = audit({
      sessions: [
        {
          sessionId: "s2",
          state: "PAID",
          createdAt: NOW - 100_000,
          leaseExpiresAt: null,
          maxLifetimeSeconds: 60,
        },
      ],
    });
    expect(young.staleSessions).toEqual([]);
  });

  it("ignores terminal rows and states outside the phase set", () => {
    const result = audit({
      sessions: [
        {
          sessionId: "s1",
          state: "EXPIRED",
          createdAt: 0,
          leaseExpiresAt: 1,
          maxLifetimeSeconds: 1,
        },
      ],
    });
    expect(result.staleSessions).toEqual([]);
    expect(result.staleCounts).toEqual(audit({}).staleCounts);
  });

  it("has one phase per persisted non-terminal lifecycle state", () => {
    // CREATED is the pre-entitlement state in the pure table; no row is ever
    // written in it, so it cannot appear in a stale-session read.
    const persisted = SESSION_STATES.filter(
      (state) => !TERMINAL_STATES.includes(state) && state !== "CREATED",
    );
    expect([...AUDIT_SESSION_PHASES].sort()).toEqual([...persisted].sort());
    for (const state of persisted) expect(isAuditSessionPhase(state)).toBe(true);
    for (const state of TERMINAL_STATES) expect(isAuditSessionPhase(state)).toBe(false);
    expect(isAuditSessionPhase("CREATED")).toBe(false);
  });

  it("publishes zero-filled gauges for every reason and phase", async () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    const collector = createLedgerAuditCollector({
      store: {
        readLedgerAudit: async () => ({ intents: [], liveRefunds: [], sessions: [] }),
      },
      registry,
      now: () => NOW,
    });
    await collector.collect();
    const text = registry.render();
    for (const reason of LEDGER_DIVERGENCE_REASONS) {
      expect(text).toContain(`sandbox_ledger_divergence{reason="${reason}"} 0`);
    }
    for (const phase of AUDIT_SESSION_PHASES) {
      expect(text).toContain(`sandbox_sessions_stale{phase="${phase}"} 0`);
    }
    expect(text).toContain("sandbox_ledger_audit_failures_total 0");
  });

  it("counts a failed read and does not pretend the books balanced", async () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    const collector = createLedgerAuditCollector({
      store: {
        readLedgerAudit: async () => {
          throw new Error("database is down");
        },
      },
      registry,
      now: () => NOW,
    });
    await collector.collect();
    const text = registry.render();
    expect(text).toContain("sandbox_ledger_audit_failures_total 1");
    // The family is registered but has no sample: not a zero on every reason.
    expect(text).toContain("sandbox_ledger_divergence 0");
  });

  it("defaults are bounded", () => {
    expect(DEFAULT_LEDGER_AUDIT_LIMITS.maxRows).toBeGreaterThan(0);
    expect(DEFAULT_LEDGER_AUDIT_LIMITS.sessionGraceMs).toBeGreaterThan(0);
  });
});

/** Claim then settle, exactly as the control API does. */
async function seedEntitlement(
  store: PostgresStore,
  id: string,
  paymentKey: string,
): Promise<void> {
  const claim = await store.claimPaymentIntent(paymentKey, "a".repeat(64), 30_000);
  if (claim.status !== "claimed") throw new Error(`seed claim was ${claim.status}`);
  await store.completeEntitlement(
    paymentKey,
    claim.token,
    paymentFixture({ paymentKey, network: "eip155:84532" }),
    sessionFixture({
      id,
      paymentKey,
      tier: "standard",
      durationSeconds: 300,
      limits: limitsFor("unit"),
      clientPublicKey: "pk-ledger-audit",
      clientNonce: `nonce-${id}`,
    }),
  );
}

describe.skipIf(!process.env.DATABASE_URL?.trim())("ledger audit over postgres", () => {
  it("seeds one divergence and one stale session and publishes them as gauges", async () => {
    const store = await freshStore();
    const now = Date.now();
    const limits: LedgerAuditLimits = { sessionGraceMs: 60_000, maxRows: 500 };

    // The money moved, the ledger row did not survive: the shape a human would
    // otherwise have to find in a spreadsheet.
    const missingLedgerKey = "a".repeat(64);
    await seedEntitlement(store, "sbx_audit_missing_ledger", missingLedgerKey);
    await sqlExec("DELETE FROM payment_ledger WHERE payment_key = $1", [missingLedgerKey]);

    // A READY session whose lease ended three minutes ago.
    await seedEntitlement(store, "sbx_audit_stale", "b".repeat(64));
    if (!(await store.setProvisioning("sbx_audit_stale", "pod-audit"))) {
      throw new Error("setProvisioning refused");
    }
    await store.setRelayToken("sbx_audit_stale", "relay-audit");
    if (!(await store.setReady("sbx_audit_stale", now - 240_000, now - 180_000, "{}", "guest"))) {
      throw new Error("setReady refused");
    }

    const registry = new MetricsRegistry({ cacheMs: 0 });
    const collector = createLedgerAuditCollector({ store, limits, registry, now: () => now });
    await collector.collect();

    const text = registry.render();
    expect(text).toContain('sandbox_ledger_divergence{reason="settled_without_ledger"} 1');
    expect(text).toContain('sandbox_ledger_divergence{reason="intent_failed_ledger_settled"} 0');
    expect(text).toContain('sandbox_ledger_divergence{reason="duplicate_refund_claim"} 0');
    expect(text).toContain('sandbox_sessions_stale{phase="READY"} 1');
    expect(text).toContain('sandbox_sessions_stale{phase="PAID"} 0');
    expect(text).toContain('sandbox_sessions_stale{phase="TERMINATING"} 0');
    expect(text).toContain("sandbox_ledger_audit_failures_total 0");

    // And the pure half names the key, which is what an operator drills into.
    const snapshot = await store.readLedgerAudit(now, limits);
    const result = auditLedger(snapshot, limits, now);
    expect(result.divergences).toContainEqual({
      paymentKey: missingLedgerKey,
      reason: "settled_without_ledger",
    });
    expect(result.staleSessions.map((session) => session.sessionId)).toContain("sbx_audit_stale");
  });
});
