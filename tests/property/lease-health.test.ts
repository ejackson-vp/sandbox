/**
 * Lease enforcement invariants.
 *
 * `LeaseHealth.enforce` is where one Kubernetes observation, one clock reading
 * and one relay state turn into a decision about a paid session. Two of its
 * rules are load-bearing and the module says so in its header, so they are
 * pinned here rather than left to the schedules the unit suite happens to pick:
 *
 *   1. a failed probe never terminates a paid session, whatever the failure;
 *   2. a missing or terminal pod needs two consecutive successful readings.
 *
 * "Consecutive" is the subtle half. A healthy read clears the strikes, and a
 * thrown probe does *not* clear them, because a timeout says nothing about the
 * pod. So missing, healthy, missing is one strike twice, while missing, throws,
 * missing is two strikes and terminates. That asymmetry is easy to get wrong in
 * either direction and is asserted directly.
 *
 * The second half of the file covers the deadline: it is immutable once READY,
 * it is read from the controller's clock and never the guest's, and it is the
 * reason the lease ends rather than an ordinary expiry when the guest was
 * already disconnected.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LeaseHealth } from "../../controller/src/reconciler/lease-health.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import { limitsFor, sessionFixture } from "../helpers/store-fixtures.js";

type Probe = "healthy" | "missing" | "terminal" | "throws";

interface Termination {
  readonly reason: string;
  readonly failure?: { code: string; message: string };
}

const READY_AT = 1_000_000;
const DEADLINE = READY_AT + 300_000;
const GRACE = 2_000;
/** Past the 2s probe gate, so `enforce` actually probes. */
const AFTER_GATE = READY_AT + 10_000;
/** Long enough that every pass clears the probe gate. */
const PASS_INTERVAL = 3_000;

const RUNNING = { phase: "Running", deleted: false } as const;
const FAILED = { phase: "Failed", deleted: false } as const;

function readySession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return sessionFixture({
    id: "sbx_lease_health",
    paymentKey: "payment-lease-health",
    tier: "standard",
    durationSeconds: 300,
    limits: limitsFor("unit"),
    clientPublicKey: "pk".repeat(22),
    clientNonce: "nn".repeat(22),
    now: READY_AT,
    overrides: {
      state: "READY",
      readyAt: READY_AT,
      leaseExpiresAt: DEADLINE,
      podName: "sbx-lease-health",
      ...overrides,
    },
  });
}

function harness(options: { now: () => number; probe: () => Probe; awaitingReconnect?: boolean }) {
  const terminations: Termination[] = [];
  const health = new LeaseHealth({
    store: {
      async requestTermination(_id: string, reason: string, failure?: { code: string; message: string }) {
        terminations.push(failure ? { reason, failure } : { reason });
        return true;
      },
    },
    provisioner: {
      async getPod() {
        switch (options.probe()) {
          case "throws":
            throw new Error("apiserver said no");
          case "missing":
            return null;
          case "terminal":
            return FAILED;
          default:
            return RUNNING;
        }
      },
    },
    relayRecovery: { awaitingReconnect: () => options.awaitingReconnect ?? false },
    leaseGraceMs: GRACE,
    now: options.now,
  });
  return { health, terminations };
}

/**
 * The documented rule, as a reference implementation: strikes only count
 * successful readings, only a healthy reading clears them, and two terminate.
 */
function expectedTerminations(probes: readonly Probe[]): number {
  let strikes = 0;
  let terminations = 0;
  for (const observed of probes) {
    if (observed === "throws") continue;
    if (observed === "healthy") {
      strikes = 0;
      continue;
    }
    strikes += 1;
    if (strikes >= 2) {
      terminations += 1;
      strikes = 0;
    }
  }
  return terminations;
}

describe("pod health never ends a lease on a single reading", () => {
  it("matches the strike model over any sequence of probe outcomes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Probe>("healthy", "missing", "terminal", "throws"), {
          minLength: 1,
          maxLength: 10,
        }),
        async (probes) => {
          // Every pass stays before the deadline, so only the probe decides.
          let clock = AFTER_GATE;
          let index = 0;
          const { health, terminations } = harness({
            now: () => clock,
            probe: () => probes[index] ?? "throws",
          });
          const session = readySession();

          for (index = 0; index < probes.length; index += 1) {
            clock = AFTER_GATE + index * PASS_INTERVAL;
            await health.enforce(session);
          }

          expect(terminations).toHaveLength(expectedTerminations(probes));
          for (const termination of terminations) {
            expect(termination).toMatchObject({
              reason: "failure:guest_exited",
              failure: { code: "guest_exited" },
            });
          }
        },
      ),
      { numRuns: 80 },
    );
  });

  it("does not terminate on any number of failed probes", async () => {
    let clock = AFTER_GATE;
    const { health, terminations } = harness({
      now: () => clock,
      probe: () => "throws",
    });
    const session = readySession();
    for (let pass = 0; pass < 6; pass += 1) {
      clock += PASS_INTERVAL;
      await health.enforce(session);
    }
    expect(terminations).toHaveLength(0);
  });

  it("keeps one strike across a thrown probe, because a timeout says nothing about the pod", async () => {
    const probes: Probe[] = ["missing", "throws", "missing"];
    let clock = AFTER_GATE;
    let index = 0;
    const { health, terminations } = harness({ now: () => clock, probe: () => probes[index] ?? "healthy" });
    const session = readySession();
    for (index = 0; index < probes.length; index += 1) {
      clock = AFTER_GATE + index * PASS_INTERVAL;
      await health.enforce(session);
    }
    expect(terminations).toHaveLength(1);
  });

  it("clears the strikes on a healthy reading", async () => {
    const probes: Probe[] = ["missing", "healthy", "missing", "healthy", "missing"];
    let clock = AFTER_GATE;
    let index = 0;
    const { health, terminations } = harness({ now: () => clock, probe: () => probes[index] ?? "healthy" });
    const session = readySession();
    for (index = 0; index < probes.length; index += 1) {
      clock = AFTER_GATE + index * PASS_INTERVAL;
      await health.enforce(session);
    }
    expect(terminations).toHaveLength(0);
  });

  it("probes at most once per two seconds per session", async () => {
    let clock = AFTER_GATE;
    let calls = 0;
    const { health } = harness({
      now: () => clock,
      probe: () => {
        calls += 1;
        return "healthy";
      },
    });
    const session = readySession();
    for (let pass = 0; pass < 20; pass += 1) {
      clock += 100;
      await health.enforce(session);
    }
    // 2s of walking at 100ms steps, so at most two probes open a window.
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("stops probing a session once it is forgotten", async () => {
    let clock = AFTER_GATE;
    let calls = 0;
    const { health } = harness({
      now: () => clock,
      probe: () => {
        calls += 1;
        return "healthy";
      },
    });
    const session = readySession();
    await health.enforce(session);
    health.forget(session.id);
    expect(calls).toBe(1);
    clock += PASS_INTERVAL;
    await health.enforce(session);
    expect(calls).toBe(2);
  });
});

describe("the deadline is the controller's, not the guest's", () => {
  it("terminates past the deadline plus grace whatever the probe says", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Probe>("healthy", "missing", "terminal", "throws"),
        fc.integer({ min: GRACE + 1, max: 600_000 }),
        async (observed, overrun) => {
          const { health, terminations } = harness({
            now: () => DEADLINE + overrun,
            probe: () => observed,
          });
          await health.enforce(readySession());
          expect(terminations.length).toBeGreaterThanOrEqual(1);
          expect(terminations[0]?.reason).toBe("lease_expired");
          expect(terminations[0]?.failure).toBeUndefined();
        },
      ),
      { numRuns: 40 },
    );
  });

  it("does not terminate inside the grace window", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: GRACE }), async (overrun) => {
        const { health, terminations } = harness({
          now: () => DEADLINE + overrun,
          probe: () => "healthy",
        });
        await health.enforce(readySession());
        expect(terminations).toHaveLength(0);
      }),
      { numRuns: 20 },
    );
  });

  it("blames relay loss when the guest was disconnected inside the window", async () => {
    const { health, terminations } = harness({
      now: () => DEADLINE + GRACE + 1,
      probe: () => "healthy",
      awaitingReconnect: true,
    });
    await health.enforce(readySession());
    expect(terminations).toHaveLength(1);
    expect(terminations[0]).toMatchObject({
      reason: "failure:relay_lost",
      failure: { code: "relay_lost" },
    });
  });

  it("never expires a session whose deadline is null", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10_000_000 }), async (offset) => {
        const { health, terminations } = harness({
          now: () => DEADLINE + offset,
          probe: () => "throws",
        });
        await health.enforce(readySession({ leaseExpiresAt: null }));
        expect(terminations).toHaveLength(0);
      }),
      { numRuns: 20 },
    );
  });

  it("does not probe a session that never got a pod", async () => {
    let calls = 0;
    const { health } = harness({
      now: () => AFTER_GATE,
      probe: () => {
        calls += 1;
        return "healthy";
      },
    });
    await health.enforce(readySession({ podName: null }));
    expect(calls).toBe(0);
  });
});
