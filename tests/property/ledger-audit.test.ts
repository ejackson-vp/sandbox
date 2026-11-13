/**
 * Property tests for the ledger audit and the sampler that publishes it.
 *
 * `tests/unit/ledger-audit.test.ts` is the table of named cases: one row per
 * rule, plus a seeded Postgres divergence. This file is the other half: the
 * audit is a total function over a snapshot, so whatever the snapshot holds,
 * the result has to add up. The counts must equal the findings they summarise,
 * a row can only be stale past its own deadline plus the grace, a balanced
 * snapshot must read clean, and the sampler must publish exactly the numbers it
 * read and nothing after a read that failed.
 *
 * The last one is the invariant an operator depends on: a gauge is a claim that
 * a query ran. A failed sample that zeroed the families would look like a
 * balanced ledger, and a sample that published a number it did not compute
 * would make the whole signal unauditable. The test drives the real sampler,
 * the real registry and the real `auditLedger`, and compares the rendered
 * gauges with the pure result for the same snapshot.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_SESSION_LIFETIME_SECONDS, SESSION_STATES, TERMINAL_STATES } from "@x402s/shared/protocol";
import { MetricsRegistry } from "../../shared/src/metrics.js";
import {
  auditLedger,
  AUDIT_SESSION_PHASES,
  isAuditSessionPhase,
  LEDGER_DIVERGENCE_REASONS,
  sessionDeadline,
  type IntentLedgerSnapshot,
  type LedgerAuditLimits,
  type LedgerAuditSnapshot,
  type LiveRefundClaim,
  type SessionLifetimeSnapshot,
} from "../../controller/src/ledger-audit.js";
import { createLedgerAuditSampler } from "../../controller/src/ledger-audit-sampler.js";
import type { IntentStatus, LedgerStatus } from "../../controller/src/store/models.js";

const NOW = 1_700_000_000_000;
const LIMITS: LedgerAuditLimits = { sessionGraceMs: 60_000 };

const LEDGER_STATUSES: readonly LedgerStatus[] = [
  "SETTLED",
  "REFUND_PENDING",
  "REFUND_SENDING",
  "REFUNDED",
];
const INTENT_STATUSES: readonly IntentStatus[] = ["claimed", "settled", "failed"];

const intent = fc.record<IntentLedgerSnapshot>({
  paymentKey: fc.stringMatching(/^[0-9a-f]{8,16}$/),
  intentStatus: fc.constantFrom<IntentStatus>(...INTENT_STATUSES),
  ledgerStatus: fc.oneof(fc.constant(null), fc.constantFrom<LedgerStatus>(...LEDGER_STATUSES)),
});

const liveRefund = fc.record<LiveRefundClaim>({
  paymentKey: fc.stringMatching(/^[0-9a-f]{8,16}$/),
  settlementNonce: fc.oneof(
    fc.constant(null),
    fc.stringMatching(/^0x[0-9a-f]{4,12}$/),
  ),
});

const session = fc.record<SessionLifetimeSnapshot>({
  sessionId: fc.stringMatching(/^sbx_[0-9a-f]{8,16}$/),
  state: fc.constantFrom(...SESSION_STATES),
  createdAt: fc.integer({ min: 0, max: NOW }),
  leaseExpiresAt: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: NOW + 3_600_000 })),
  maxLifetimeSeconds: fc.oneof(
    fc.constant(null),
    fc.integer({ min: 1, max: MAX_SESSION_LIFETIME_SECONDS }),
  ),
});

const snapshotArb: fc.Arbitrary<LedgerAuditSnapshot> = fc.record({
  intents: fc.array(intent, { maxLength: 8 }),
  liveRefunds: fc.array(liveRefund, { maxLength: 8 }),
  sessions: fc.array(session, { maxLength: 8 }),
});

/** The rendered value of one gauge sample, or undefined when it is absent. */
function gauge(registry: MetricsRegistry, name: string, label: string): number | undefined {
  const line = registry
    .render()
    .split("\n")
    .find((candidate) => candidate.startsWith(`${name}{${label}} `));
  if (!line) return undefined;
  return Number(line.slice(line.lastIndexOf(" ") + 1));
}

describe("ledger audit", () => {
  it("is total, and every count equals the findings it summarises", () => {
    fc.assert(
      fc.property(snapshotArb, (snapshot) => {
        const result = auditLedger(snapshot, LIMITS, NOW);

        // The families are a closed set, present even at zero.
        expect(Object.keys(result.divergenceCounts).sort()).toEqual(
          [...LEDGER_DIVERGENCE_REASONS].sort(),
        );
        expect(Object.keys(result.staleCounts).sort()).toEqual([...AUDIT_SESSION_PHASES].sort());

        const divergenceTotal = LEDGER_DIVERGENCE_REASONS.reduce(
          (sum, reason) => sum + result.divergenceCounts[reason],
          0,
        );
        expect(divergenceTotal).toBe(result.divergences.length);
        const staleTotal = AUDIT_SESSION_PHASES.reduce(
          (sum, phase) => sum + result.staleCounts[phase],
          0,
        );
        expect(staleTotal).toBe(result.staleSessions.length);

        // A finding can only name a row the snapshot held.
        const paymentKeys = new Set(snapshot.intents.map((row) => row.paymentKey));
        for (const finding of result.divergences) {
          expect(LEDGER_DIVERGENCE_REASONS).toContain(finding.reason);
          if (finding.reason !== "duplicate_refund_claim") {
            expect(paymentKeys.has(finding.paymentKey)).toBe(true);
          }
        }
        const sessionIds = new Set(snapshot.sessions.map((row) => row.sessionId));
        for (const stale of result.staleSessions) {
          expect(sessionIds.has(stale.sessionId)).toBe(true);
          expect(isAuditSessionPhase(stale.phase)).toBe(true);
          // Past the grace period, and the reported lateness is the truth.
          expect(stale.overdueMs).toBeGreaterThan(LIMITS.sessionGraceMs);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("calls only the rows that break a rule, and never a balanced snapshot", () => {
    // Balanced by construction: settled intents keep a ledger row, failed ones
    // do not claim service, live claims are grouped by a distinct identity, and
    // no session is past its deadline.
    const key = fc.stringMatching(/^[0-9a-f]{8,16}$/);
    const balancedIntent = fc.record({
      paymentKey: key,
      intentStatus: fc.constantFrom<IntentStatus>("claimed", "settled", "failed"),
      ledgerStatus: fc.oneof(fc.constant(null), fc.constantFrom<LedgerStatus>(...LEDGER_STATUSES)),
    });

    fc.assert(
      fc.property(
        fc.array(balancedIntent, { maxLength: 8 }),
        fc.array(fc.stringMatching(/^0x[0-9a-f]{4,12}$/), { maxLength: 6 }),
        fc.array(session, { maxLength: 6 }),
        (intents, nonces, sessions) => {
          const repaired: IntentLedgerSnapshot[] = intents.map((row) => {
            if (row.intentStatus === "settled" && row.ledgerStatus === null) {
              return { ...row, ledgerStatus: "SETTLED" };
            }
            if (row.intentStatus === "failed" && row.ledgerStatus === "SETTLED") {
              return { ...row, ledgerStatus: "REFUNDED" };
            }
            return row;
          });
          // One nonce each, so nothing can share a refund identity.
          const claims: LiveRefundClaim[] = nonces.map((nonce, index) => ({
            paymentKey: `k${index.toString(16).padStart(8, "0")}`,
            settlementNonce: nonce,
          }));
          // A deadline well past the grace window: every row is inside it.
          const fresh: SessionLifetimeSnapshot[] = sessions.map((row) => ({
            ...row,
            createdAt: NOW,
            leaseExpiresAt: null,
            maxLifetimeSeconds: MAX_SESSION_LIFETIME_SECONDS,
          }));

          const result = auditLedger(
            { intents: repaired, liveRefunds: claims, sessions: fresh },
            LIMITS,
            NOW,
          );
          expect(result.divergences).toEqual([]);
          expect(result.staleSessions).toEqual([]);
          for (const reason of LEDGER_DIVERGENCE_REASONS) {
            expect(result.divergenceCounts[reason]).toBe(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("reports a session stale exactly when it is past its own deadline plus grace", () => {
    fc.assert(
      fc.property(
        session,
        fc.integer({ min: 0, max: 3_600_000 }),
        (row, offset) => {
          const deadline = sessionDeadline(row);
          // A moment before the grace ends, and a moment after.
          const inside = auditLedger({ intents: [], liveRefunds: [], sessions: [row] }, LIMITS, deadline + LIMITS.sessionGraceMs);
          const outside = auditLedger(
            { intents: [], liveRefunds: [], sessions: [row] },
            LIMITS,
            deadline + LIMITS.sessionGraceMs + 1 + offset,
          );
          const reportable = isAuditSessionPhase(row.state);
          expect(inside.staleSessions).toHaveLength(0);
          expect(outside.staleSessions).toHaveLength(reportable ? 1 : 0);
          if (isAuditSessionPhase(row.state)) {
            expect(outside.staleSessions[0]).toEqual({
              sessionId: row.sessionId,
              phase: row.state,
              overdueMs: LIMITS.sessionGraceMs + 1 + offset,
            });
            expect(outside.staleCounts[row.state]).toBe(1);
          } else {
            expect(TERMINAL_STATES.includes(row.state) || row.state === "CREATED").toBe(true);
          }

          // The deadline itself: the lease when READY was reached, otherwise the
          // wall-clock cap, with the protocol maximum standing in for a null cap.
          if (row.leaseExpiresAt !== null) {
            expect(deadline).toBe(row.leaseExpiresAt);
          } else {
            expect(deadline).toBe(
              row.createdAt +
                (row.maxLifetimeSeconds ?? MAX_SESSION_LIFETIME_SECONDS) * 1000,
            );
          }        },
      ),
      { numRuns: 200 },
    );
  });

  it("publishes exactly the figures it read, and keeps them when a read fails", async () => {
    await fc.assert(
      fc.asyncProperty(snapshotArb, fc.integer({ min: 0, max: 3_600_000 }), async (snapshot, later) => {
        const registry = new MetricsRegistry({ cacheMs: 0 });
        let current: LedgerAuditSnapshot = snapshot;
        let fail = false;
        let clock = NOW;
        const sampler = createLedgerAuditSampler({
          store: {
            async readLedgerAudit() {
              if (fail) throw new Error("database is down");
              return current;
            },
          },
          registry,
          limits: LIMITS,
          now: () => clock,
          intervalMs: 300_000,
        });

        await sampler.sample();
        const expected = auditLedger(snapshot, LIMITS, NOW);
        for (const reason of LEDGER_DIVERGENCE_REASONS) {
          expect(gauge(registry, "sandbox_ledger_divergence", `reason="${reason}"`)).toBe(
            expected.divergenceCounts[reason],
          );
        }
        for (const phase of AUDIT_SESSION_PHASES) {
          expect(gauge(registry, "sandbox_sessions_stale", `phase="${phase}"`)).toBe(
            expected.staleCounts[phase],
          );
        }

        // The same sampler reads a different snapshot: what it publishes has to
        // be the new result, not the first one.
        current = {
          intents: snapshot.intents.slice(0, 1).map((row) => ({
            ...row,
            intentStatus: "settled" as const,
            ledgerStatus: null,
          })),
          liveRefunds: [
            { paymentKey: "shared-a", settlementNonce: "0xshared" },
            { paymentKey: "shared-b", settlementNonce: "0xshared" },
          ],
          sessions: [],
        };
        clock += later + 1;
        await sampler.sample();
        const next = auditLedger(current, LIMITS, clock);
        for (const reason of LEDGER_DIVERGENCE_REASONS) {
          expect(gauge(registry, "sandbox_ledger_divergence", `reason="${reason}"`)).toBe(
            next.divergenceCounts[reason],
          );
        }
        expect(gauge(registry, "sandbox_ledger_divergence", 'reason="duplicate_refund_claim"')).toBe(2);
        if (current.intents.length === 1) {
          expect(gauge(registry, "sandbox_ledger_divergence", 'reason="settled_without_ledger"')).toBe(1);
        }

        // A read that fails touches no gauge: the last figures stay, and the
        // failure counter is the only new sample. Zeroing them would read as a
        // balanced ledger.
        const before = registry.render();
        fail = true;
        clock += 1_000;
        await sampler.sample();
        const after = registry.render();
        const figuresBefore = before
          .split("\n")
          .filter((line) => line.startsWith("sandbox_ledger_divergence") || line.startsWith("sandbox_sessions_stale"))
          .join("\n");
        const figuresAfter = after
          .split("\n")
          .filter((line) => line.startsWith("sandbox_ledger_divergence") || line.startsWith("sandbox_sessions_stale"))
          .join("\n");
        expect(figuresAfter).toBe(figuresBefore);
        expect(after).toContain("sandbox_ledger_audit_failures_total 1");
      }),
      { numRuns: 60 },
    );
  });
});
