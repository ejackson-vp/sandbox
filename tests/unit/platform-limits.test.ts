/**
 * Platform limits are the tenant boundary, so every knob is parsed once and
 * refuses junk.
 *
 * The regression these pin: a private parser in `shared/src/tiers.ts` returned
 * the default whenever a value was not a number, so `MAX_DISK_MIB=512x` came
 * back as 8192 MiB, the loosest workspace the code allows, and nothing at
 * startup said the operator's limit had been ignored.
 */
import { describe, expect, it } from "vitest";
import {
  PLATFORM_LIMIT_BOUNDS,
  loadPlatformLimits,
  type PlatformLimitBound,
} from "../../shared/src/entries/payment.js";

const ENV_KEY: Record<keyof typeof PLATFORM_LIMIT_BOUNDS, string> = {
  maxLeaseSeconds: "MAX_LEASE_SECONDS",
  maxCpuMillis: "MAX_CPU_MILLIS",
  maxMemoryMiB: "MAX_MEMORY_MIB",
  maxDiskMiB: "MAX_DISK_MIB",
  maxOutputBytes: "MAX_OUTPUT_BYTES",
  maxFileBytes: "MAX_FILE_BYTES",
  maxCommandSeconds: "MAX_COMMAND_SECONDS",
  maxProcesses: "MAX_PROCESSES",
};

const FIELDS = Object.entries(PLATFORM_LIMIT_BOUNDS) as Array<
  [keyof typeof PLATFORM_LIMIT_BOUNDS, PlatformLimitBound]
>;

describe("platform limits", () => {
  it("keeps the published defaults when nothing is set", () => {
    const limits = loadPlatformLimits({});
    for (const [field, bound] of FIELDS) {
      expect(limits[field]).toBe(bound.def);
    }
    expect(limits.allowCustom).toBe(true);
  });

  it("refuses the reported MAX_DISK_MIB typo instead of widening the workspace", () => {
    expect(() => loadPlatformLimits({ MAX_DISK_MIB: "512x" })).toThrow(/MAX_DISK_MIB=512x/);
  });

  it("refuses a value that only a truncating parser would accept", () => {
    expect(() => loadPlatformLimits({ MAX_CPU_MILLIS: "1500.5" })).toThrow(/MAX_CPU_MILLIS/);
    expect(() => loadPlatformLimits({ MAX_PROCESSES: "-1" })).toThrow(/MAX_PROCESSES/);
    expect(() => loadPlatformLimits({ MAX_OUTPUT_BYTES: "" })).not.toThrow();
  });

  for (const [field, bound] of FIELDS) {
    const key = ENV_KEY[field];

    describe(key, () => {
      it("refuses junk rather than taking the default", () => {
        expect(() => loadPlatformLimits({ [key]: "512x" })).toThrow(
          new RegExp(`${key}=512x`),
        );
      });

      it("accepts its ceiling and refuses one step above it", () => {
        expect(loadPlatformLimits({ [key]: String(bound.max) })[field]).toBe(bound.max);
        expect(() => loadPlatformLimits({ [key]: String(bound.max + 1) })).toThrow(
          new RegExp(key),
        );
      });

      it("refuses a value below its floor", () => {
        expect(() => loadPlatformLimits({ [key]: String(bound.min - 1) })).toThrow(
          new RegExp(key),
        );
      });
    });
  }

  it("treats a custom-duration typo as off rather than on", () => {
    expect(loadPlatformLimits({ ALLOW_CUSTOM_DURATIONS: "false" }).allowCustom).toBe(false);
    expect(loadPlatformLimits({ ALLOW_CUSTOM_DURATIONS: "flase" }).allowCustom).toBe(false);
    expect(loadPlatformLimits({ ALLOW_CUSTOM_DURATIONS: "true" }).allowCustom).toBe(true);
  });
});
