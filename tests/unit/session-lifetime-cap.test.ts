/**
 * One home for MAX_SESSION_LIFETIME_SECONDS.
 *
 * The cap was imported for the comparison and then typed out again in the
 * error messages and in six zod limits, so raising it would have left the API
 * and the controller refusing at the old eight hours with no compile error and
 * no test failure. These tests pin both halves: the schemas take their bound
 * from the constant, and the literal copy does not come back.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_SESSION_LIFETIME_SECONDS } from "../../shared/src/entries/protocol.js";
import { DEFAULT_TIERS, resolveSessionSpec, loadPlatformLimits } from "../../shared/src/entries/payment.js";
import { createSchema } from "../../api/src/schemas.js";
import { specSchema } from "../../controller/src/control-api-schemas.js";

const limits = loadPlatformLimits({});

/** A create body with only the fields the schema insists on. */
const createBody = (extra: Record<string, unknown>) => ({
  clientPublicKey: "a".repeat(44),
  clientNonce: "b".repeat(44),
  ...extra,
});

const specBody = (extra: Record<string, unknown>) => ({
  tier: "standard" as const,
  durationSeconds: 300,
  limits: {
    cpuMillis: 1000,
    memoryMiB: 1024,
    diskMiB: 1024,
    maxOutputBytes: 256 * 1024,
    maxFileBytes: 8 * 1024 * 1024,
    maxCommandSeconds: 300,
    maxProcesses: 256,
  },
  ...extra,
});

describe("session lifetime cap", () => {
  it("accepts the cap in the API schema and refuses one second past it", () => {
    expect(createSchema.safeParse(createBody({ maxLifetimeSeconds: MAX_SESSION_LIFETIME_SECONDS })).success).toBe(true);
    expect(createSchema.safeParse(createBody({ maxLifetimeSeconds: MAX_SESSION_LIFETIME_SECONDS + 1 })).success).toBe(false);
    expect(
      createSchema.safeParse(
        createBody({ idlePolicy: { maxIdleSeconds: MAX_SESSION_LIFETIME_SECONDS } }),
      ).success,
    ).toBe(true);
    expect(
      createSchema.safeParse(
        createBody({ idlePolicy: { maxIdleSeconds: MAX_SESSION_LIFETIME_SECONDS + 1 } }),
      ).success,
    ).toBe(false);
    expect(
      createSchema.safeParse(
        createBody({ idlePolicy: { suspendedDurationSeconds: MAX_SESSION_LIFETIME_SECONDS } }),
      ).success,
    ).toBe(true);
  });

  it("accepts the cap in the controller schema and refuses one second past it", () => {
    expect(specSchema.safeParse(specBody({ maxLifetimeSeconds: MAX_SESSION_LIFETIME_SECONDS })).success).toBe(true);
    expect(specSchema.safeParse(specBody({ maxLifetimeSeconds: MAX_SESSION_LIFETIME_SECONDS + 1 })).success).toBe(false);
    expect(
      specSchema.safeParse(
        specBody({ idlePolicy: { suspendedDurationSeconds: MAX_SESSION_LIFETIME_SECONDS } }),
      ).success,
    ).toBe(true);
    expect(
      specSchema.safeParse(
        specBody({ idlePolicy: { suspendedDurationSeconds: MAX_SESSION_LIFETIME_SECONDS + 1 } }),
      ).success,
    ).toBe(false);
  });

  it("names the constant in the resolver's refusal", () => {
    const base = {
      tier: "standard" as const,
      clientPublicKey: "a".repeat(44),
      clientNonce: "b".repeat(44),
    };
    const idle = resolveSessionSpec(
      { ...base, idlePolicy: { maxIdleSeconds: MAX_SESSION_LIFETIME_SECONDS + 1 } },
      DEFAULT_TIERS,
      limits,
    );
    expect(idle).toMatchObject({ ok: false, code: "invalid_idle_policy" });
    expect(!idle.ok && idle.message).toBe(
      `maxIdleSeconds must be between 1 and ${MAX_SESSION_LIFETIME_SECONDS}`,
    );

    const suspended = resolveSessionSpec(
      { ...base, idlePolicy: { suspendedDurationSeconds: MAX_SESSION_LIFETIME_SECONDS + 1 } },
      DEFAULT_TIERS,
      limits,
    );
    expect(suspended).toMatchObject({ ok: false, code: "invalid_idle_policy" });
    expect(!suspended.ok && suspended.message).toBe(
      `suspendedDurationSeconds must be between 1 and ${MAX_SESSION_LIFETIME_SECONDS}`,
    );
  });

  it("keeps the literal out of every site that validates the cap", () => {
    // The four files that used to carry their own copy. If the cap moves, these
    // keep compiling against the constant and the test above keeps passing;
    // a pasted literal here is what silently pins the old value.
    const sources = [
      "../../shared/src/tiers.ts",
      "../../controller/src/control-api-schemas.ts",
      "../../api/src/schemas.ts",
      "../../cli/src/commands.ts",
    ];
    for (const source of sources) {
      const text = readFileSync(new URL(source, import.meta.url), "utf8");
      expect(text, source).not.toMatch(/\b28800\b/);
    }
  });
});
