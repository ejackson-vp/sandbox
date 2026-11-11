import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIERS,
  loadPlatformLimits,
  resolveSessionSpec,
} from "../../shared/src/entries/payment.js";

const limits = loadPlatformLimits({});

describe("baseline and peak resources", () => {
  it("defaults the baseline to a quarter of the peak", () => {
    const r = resolveSessionSpec(
      { tier: "custom", durationSeconds: 60, cpuMillis: 1000, memoryMiB: 1024, clientPublicKey: "x", clientNonce: "y" },
      DEFAULT_TIERS,
      limits,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.limits.cpuMillis).toBe(1000);
    expect(r.spec.baseline).toEqual({ cpuMillis: 250, memoryMiB: 256 });
  });

  it("keeps an explicit baseline", () => {
    const r = resolveSessionSpec(
      {
        tier: "custom",
        durationSeconds: 60,
        cpuMillis: 1000,
        memoryMiB: 1024,
        baselineCpuMillis: 500,
        baselineMemoryMiB: 512,
        clientPublicKey: "x",
        clientNonce: "y",
      },
      DEFAULT_TIERS,
      limits,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.baseline).toEqual({ cpuMillis: 500, memoryMiB: 512 });
  });

  it("rejects a baseline above the peak", () => {
    const r = resolveSessionSpec(
      {
        tier: "custom",
        durationSeconds: 60,
        cpuMillis: 1000,
        memoryMiB: 1024,
        baselineCpuMillis: 2000,
        clientPublicKey: "x",
        clientNonce: "y",
      },
      DEFAULT_TIERS,
      limits,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_baseline");
  });
});
