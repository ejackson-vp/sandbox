/**
 * Pricing invariants. Resource entitlement is monotonic: asking for more can
 * never become cheaper, and a custom spec can never be free or NaN.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../shared/src/entries/crypto.js";
import {
  specHash,
  DEFAULT_TIERS,
  loadPlatformLimits,
  loadTiers,
  resolveSessionSpec,
} from "../../shared/src/entries/payment.js";
import { formatUsd, parseUsdPrice } from "../../shared/src/entries/money.js";
import { type CreateSessionRequest } from "../../shared/src/entries/protocol.js";

const limits = loadPlatformLimits({});
const tiers = DEFAULT_TIERS;

function custom(overrides: Partial<CreateSessionRequest>): CreateSessionRequest {
  return {
    tier: "custom",
    durationSeconds: 300,
    clientPublicKey: "pk".repeat(22),
    clientNonce: "nn".repeat(22),
    ...overrides,
  };
}

function priceAtomic(req: CreateSessionRequest): bigint {
  const res = resolveSessionSpec(req, tiers, limits);
  if (!res.ok) throw new Error(`${res.code}: ${res.message}`);
  return parseUsdPrice(res.priceUsd).amount;
}

describe("custom session pricing", () => {
  it("charges more for more resources at the same duration", () => {
    const small = priceAtomic(custom({ durationSeconds: 300, cpuMillis: 100, memoryMiB: 128, diskMiB: 16 }));
    const standard = priceAtomic(custom({ durationSeconds: 300, cpuMillis: 1000, memoryMiB: 1024, diskMiB: 1024 }));
    const large = priceAtomic(custom({ durationSeconds: 300, cpuMillis: 4000, memoryMiB: 8192, diskMiB: 8192 }));
    expect(small).toBeLessThan(standard);
    expect(standard).toBeLessThan(large);
    expect(large).not.toBe(standard);
  });

  it("never returns a zero, negative or NaN price", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: limits.maxLeaseSeconds }),
        fc.integer({ min: 100, max: limits.maxCpuMillis }),
        fc.integer({ min: 128, max: limits.maxMemoryMiB }),
        fc.integer({ min: 16, max: limits.maxDiskMiB }),
        (durationSeconds, cpuMillis, memoryMiB, diskMiB) => {
          const atomic = priceAtomic(custom({ durationSeconds, cpuMillis, memoryMiB, diskMiB }));
          expect(atomic).toBeGreaterThan(0n);
          expect(formatUsd(atomic.toString())).toMatch(/^\$\d+(\.\d{1,6})?$/);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("is monotonic in every priced dimension", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: Math.min(limits.maxLeaseSeconds, 3600) }),
        fc.integer({ min: 100, max: limits.maxCpuMillis }),
        fc.integer({ min: 128, max: limits.maxMemoryMiB }),
        fc.integer({ min: 16, max: limits.maxDiskMiB }),
        fc.integer({ min: 1, max: 512 }),
        (duration, cpu, mem, disk, bump) => {
          const base = priceAtomic(custom({ durationSeconds: duration, cpuMillis: cpu, memoryMiB: mem, diskMiB: disk }));
          const moreCpu = priceAtomic(
            custom({ durationSeconds: duration, cpuMillis: Math.min(limits.maxCpuMillis, cpu + bump), memoryMiB: mem, diskMiB: disk }),
          );
          const moreMem = priceAtomic(
            custom({ durationSeconds: duration, cpuMillis: cpu, memoryMiB: Math.min(limits.maxMemoryMiB, mem + bump), diskMiB: disk }),
          );
          const moreDisk = priceAtomic(
            custom({ durationSeconds: duration, cpuMillis: cpu, memoryMiB: mem, diskMiB: Math.min(limits.maxDiskMiB, disk + bump) }),
          );
          const longer = priceAtomic(
            custom({
              durationSeconds: Math.min(limits.maxLeaseSeconds, duration + Math.max(1, Math.floor(bump / 8))),
              cpuMillis: cpu,
              memoryMiB: mem,
              diskMiB: disk,
            }),
          );
          expect(moreCpu).toBeGreaterThanOrEqual(base);
          expect(moreMem).toBeGreaterThanOrEqual(base);
          expect(moreDisk).toBeGreaterThanOrEqual(base);
          expect(longer).toBeGreaterThanOrEqual(base);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("priced spec and admitted spec", () => {
  it("resolves to the same spec that was priced", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: limits.maxLeaseSeconds }),
        fc.integer({ min: 100, max: limits.maxCpuMillis }),
        fc.integer({ min: 128, max: limits.maxMemoryMiB }),
        fc.integer({ min: 16, max: limits.maxDiskMiB }),
        (durationSeconds, cpuMillis, memoryMiB, diskMiB) => {
          const req = custom({ durationSeconds, cpuMillis, memoryMiB, diskMiB });
          const first = resolveSessionSpec(req, tiers, limits);
          expect(first.ok).toBe(true);
          if (!first.ok) return;
          const second = resolveSessionSpec(
            {
              tier: "custom",
              durationSeconds: first.spec.durationSeconds,
              cpuMillis: first.spec.limits.cpuMillis,
              memoryMiB: first.spec.limits.memoryMiB,
              diskMiB: first.spec.limits.diskMiB,
              clientPublicKey: req.clientPublicKey,
              clientNonce: req.clientNonce,
            },
            tiers,
            limits,
          );
          expect(second.ok).toBe(true);
          if (!second.ok) return;
          expect(canonicalJson(second.spec)).toBe(canonicalJson(first.spec));
          expect(second.priceUsd).toBe(first.priceUsd);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("changes the payment binding when an admitted limit is tampered with", () => {
    const req = custom({ durationSeconds: 300, cpuMillis: 500, memoryMiB: 512, diskMiB: 256 });
    const res = resolveSessionSpec(req, tiers, limits);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const tampered = {
      ...res.spec,
      limits: { ...res.spec.limits, cpuMillis: 4000, memoryMiB: 8192 },
    };
    expect(specHash(tampered)).not.toBe(specHash(res.spec));
  });
});

describe("tier configuration validation", () => {
  it("rejects negative, zero and NaN prices", () => {
    for (const priceUsd of ["$0", "-1", "$NaN", "free", "$0.000000"]) {
      expect(() =>
        loadTiers({ SESSION_TIERS: JSON.stringify({ standard: { priceUsd } }) }),
      ).toThrow(/priceUsd/);
    }
  });

  it("rejects leases beyond the platform maximum", () => {
    expect(() =>
      loadTiers({ SESSION_TIERS: JSON.stringify({ long: { durationSeconds: 10_000_000 } }) }),
    ).toThrow(/durationSeconds/);
  });

  it("keeps valid overrides", () => {
    const parsed = loadTiers({
      SESSION_TIERS: JSON.stringify({ standard: { priceUsd: "$0.07", cpuMillis: 2000 } }),
    });
    expect(parsed.standard.priceUsd).toBe("$0.07");
    expect(parsed.standard.cpuMillis).toBe(2000);
    expect(parsed.short).toEqual(DEFAULT_TIERS.short);
  });
});
