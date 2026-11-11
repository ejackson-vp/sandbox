/**
 * The lease deadline is the purchased duration, capped by the wall-clock
 * lifetime. Both are wall-clock bounds on the same session, so a clock step
 * that moves one must not move them apart.
 */
import { describe, expect, it } from "vitest";
import { MAX_SESSION_LIFETIME_SECONDS, leaseDeadline } from "@x402s/shared/protocol";

const CREATED = 1_700_000_000_000;
const DURATION = 300;

describe("leaseDeadline", () => {
  it("is the purchased duration when readiness is not delayed", () => {
    expect(leaseDeadline(CREATED, CREATED, DURATION, 900)).toBe(CREATED + 300_000);
  });

  it("includes a slow provision inside the lifetime", () => {
    // 60s to schedule and boot, 300s lease, 900s lifetime: 360s used of 900s.
    expect(leaseDeadline(CREATED, CREATED + 60_000, DURATION, 900)).toBe(
      CREATED + 360_000,
    );
  });

  it("clamps a forward clock step to createdAt + maxLifetimeSeconds", () => {
    // The clock stepped 4 minutes forward before the guest hello, so the
    // purchased lease would run to createdAt + 540s against a 480s lifetime.
    const expiry = leaseDeadline(CREATED, CREATED + 240_000, DURATION, 480);
    expect(expiry).toBe(CREATED + 480_000);
    expect(expiry).toBeLessThan(CREATED + 240_000 + DURATION * 1000);
  });

  it("clamps after a resume that spends most of the lifetime suspended", () => {
    // Suspended for 600s of an 900s lifetime, then resumed with a 300s lease.
    expect(leaseDeadline(CREATED, CREATED + 600_000, DURATION, 900)).toBe(
      CREATED + 900_000,
    );
  });

  it("does not extend a lease after a backward step", () => {
    // A backward step makes readiness look earlier than settlement. The lease
    // is never longer than the duration, so the cap does not apply.
    expect(leaseDeadline(CREATED, CREATED - 120_000, DURATION, 900)).toBe(
      CREATED + 180_000,
    );
  });

  it("uses the protocol maximum when the session has no lifetime", () => {
    const midnight = CREATED + 3_600_000;
    expect(leaseDeadline(CREATED, midnight, DURATION, null)).toBe(midnight + 300_000);
    expect(leaseDeadline(CREATED, midnight, DURATION, null)).toBeLessThan(
      CREATED + MAX_SESSION_LIFETIME_SECONDS * 1000,
    );
  });

  it("is monotone in readyAt and never above the cap", () => {
    for (let delay = 0; delay <= 1_000_000; delay += 25_000) {
      const expiry = leaseDeadline(CREATED, CREATED + delay, DURATION, 900);
      // Never later than the lifetime cap, never later than the purchase, and
      // never earlier than the cap when the cap is what binds.
      expect(expiry).toBeLessThanOrEqual(CREATED + 900_000);
      expect(expiry).toBeLessThanOrEqual(CREATED + delay + DURATION * 1000);
      expect(expiry).toBeGreaterThanOrEqual(
        Math.min(CREATED + delay + DURATION * 1000, CREATED + 900_000),
      );
    }
  });
});
