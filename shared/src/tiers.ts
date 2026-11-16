/**
 * Session tiers, resource limits and lease validation.
 *
 * One table shared by the API (pricing + validation), the controller (limits)
 * and the SDK. Environment overrides let a deployment change prices/limits
 * without code changes; hard caps are enforced regardless.
 */
import { canonicalJson, sha256Hex } from "./crypto.js";
import { envBool, envInt } from "./env.js";
import { formatUsd, parseUsdPrice } from "./money.js";
import { resolveRuntime } from "./runtimes.js";
import {
  MAX_LEASE_SECONDS,
  MAX_SESSION_LIFETIME_SECONDS,
  MIN_LEASE_SECONDS,
  type CreateSessionRequest,
  type SessionLimits,
  type SessionSpec,
  type SessionTier,
} from "./protocol.js";

export interface TierDefinition {
  durationSeconds: number;
  cpuMillis: number;
  memoryMiB: number;
  diskMiB: number;
  priceUsd: string;
}

export type TierTable = Record<Exclude<SessionTier, "custom">, TierDefinition>;

/**
 * Preset tiers from smallest to largest. `custom` is deliberately absent: it is
 * not comparable with a configured maximum, so `tierWithinMax` refuses it
 * rather than guessing where it sits.
 */
const TIER_ORDER = ["short", "standard", "extended", "long"] as const;

/** Rank of a preset tier, or -1 for `custom`. */
function tierRank(tier: SessionTier): number {
  return (TIER_ORDER as readonly string[]).indexOf(tier);
}

/** Whether a requested tier is at or below an allowlist entry's maximum. */
export function tierWithinMax(tier: SessionTier, maxTier: SessionTier): boolean {
  const rank = tierRank(tier);
  return rank >= 0 && rank <= tierRank(maxTier);
}

export const DEFAULT_TIERS: TierTable = {
  short: { durationSeconds: 60, cpuMillis: 500, memoryMiB: 512, diskMiB: 256, priceUsd: "$0.02" },
  standard: { durationSeconds: 300, cpuMillis: 1000, memoryMiB: 1024, diskMiB: 1024, priceUsd: "$0.05" },
  extended: { durationSeconds: 900, cpuMillis: 2000, memoryMiB: 2048, diskMiB: 2048, priceUsd: "$0.10" },
  long: { durationSeconds: 1800, cpuMillis: 2000, memoryMiB: 4096, diskMiB: 4096, priceUsd: "$0.20" },
};

export interface PlatformLimits {
  maxLeaseSeconds: number;
  maxCpuMillis: number;
  maxMemoryMiB: number;
  maxDiskMiB: number;
  maxOutputBytes: number;
  maxFileBytes: number;
  maxCommandSeconds: number;
  maxProcesses: number;
  allowCustom: boolean;
}

/**
 * Default, floor and ceiling for every platform knob.
 *
 * These are a contract, not tuning constants: `MAX_*` is what bounds a tenant,
 * so a value outside the band is a configuration mistake and refuses startup
 * instead of being coerced. A private parser here used to return the default on
 * junk (`MAX_DISK_MIB=512x` became 8192 MiB, the loosest workspace the code
 * allows) and `maxCpuMillis` had no ceiling at all, so a typo widened the
 * tenant boundary rather than failing at boot.
 *
 * Each ceiling is a value the rest of the system can honour. A session above 64
 * vCPU or 256 GiB of memory cannot be scheduled on any node this design
 * documents (8 vCPU with ~13 GiB allocatable in `deploy/talos/README.md`), and a
 * workspace above 256 GiB is more than an order of magnitude past the 8 GiB
 * volume that deployment sizes per session. A per-stream output above 16 MiB
 * cannot be returned in one API response (`MAX_BODY_BYTES` defaults to 32 MiB
 * and base64 inflates by 4/3). A command longer than
 * `MAX_SESSION_LIFETIME_SECONDS` outlives the session it runs in. A 1 GiB file
 * is the largest single object a workspace of that ceiling should have to hold,
 * and the process cap is advisory (the pod cgroup's `pids.max` is the
 * enforcement), so its ceiling only has to be a number a pid table can hold.
 */
export interface PlatformLimitBound {
  def: number;
  min: number;
  max: number;
}

export const PLATFORM_LIMIT_BOUNDS = {
  maxLeaseSeconds: { def: MAX_LEASE_SECONDS, min: MIN_LEASE_SECONDS, max: MAX_LEASE_SECONDS },
  maxCpuMillis: { def: 4000, min: 100, max: 64_000 },
  maxMemoryMiB: { def: 8192, min: 128, max: 262_144 },
  maxDiskMiB: { def: 8192, min: 16, max: 262_144 },
  maxOutputBytes: { def: 256 * 1024, min: 1024, max: 16 * 1024 * 1024 },
  maxFileBytes: { def: 8 * 1024 * 1024, min: 1024, max: 1024 * 1024 * 1024 },
  maxCommandSeconds: { def: 300, min: 1, max: MAX_SESSION_LIFETIME_SECONDS },
  maxProcesses: { def: 256, min: 1, max: 65_536 },
} as const satisfies Record<keyof Omit<PlatformLimits, "allowCustom">, PlatformLimitBound>;

/** The env variable that sets each bound. One name, one parser, one message. */
const PLATFORM_LIMIT_ENV: Record<keyof typeof PLATFORM_LIMIT_BOUNDS, string> = {
  maxLeaseSeconds: "MAX_LEASE_SECONDS",
  maxCpuMillis: "MAX_CPU_MILLIS",
  maxMemoryMiB: "MAX_MEMORY_MIB",
  maxDiskMiB: "MAX_DISK_MIB",
  maxOutputBytes: "MAX_OUTPUT_BYTES",
  maxFileBytes: "MAX_FILE_BYTES",
  maxCommandSeconds: "MAX_COMMAND_SECONDS",
  maxProcesses: "MAX_PROCESSES",
};

export function loadPlatformLimits(env: NodeJS.ProcessEnv = process.env): PlatformLimits {
  /** One field, read through its own bounds, so the pair cannot be mixed up. */
  const read = <K extends keyof typeof PLATFORM_LIMIT_BOUNDS>(field: K): number => {
    const { def, min, max } = PLATFORM_LIMIT_BOUNDS[field];
    const name = PLATFORM_LIMIT_ENV[field];
    return envInt(env[name], def, min, max, name);
  };
  return {
    maxLeaseSeconds: read("maxLeaseSeconds"),
    maxCpuMillis: read("maxCpuMillis"),
    maxMemoryMiB: read("maxMemoryMiB"),
    maxDiskMiB: read("maxDiskMiB"),
    maxOutputBytes: read("maxOutputBytes"),
    maxFileBytes: read("maxFileBytes"),
    maxCommandSeconds: read("maxCommandSeconds"),
    maxProcesses: read("maxProcesses"),
    // Custom sessions used to be enabled by anything except the exact string
    // "false", so `ALLOW_CUSTOM_DURATIONS=flase` turned them on. envBool reads
    // an unrecognised value as false, which is the fail-closed direction.
    allowCustom: envBool(env.ALLOW_CUSTOM_DURATIONS, true),
  };
}

export function loadTiers(env: NodeJS.ProcessEnv = process.env): TierTable {
  if (!env.SESSION_TIERS) return DEFAULT_TIERS;
  const parsed = JSON.parse(env.SESSION_TIERS) as Partial<TierTable>;
  const out = { ...DEFAULT_TIERS };
  for (const key of Object.keys(DEFAULT_TIERS) as Array<keyof TierTable>) {
    const value = parsed[key];
    if (value) out[key] = { ...DEFAULT_TIERS[key], ...value };
  }
  for (const [name, tier] of Object.entries(out)) {
    // A bad override must not become a free, negative or NaN price, and it
    // must not advertise a lease longer than the platform maximum.
    const priceOk = /^\$?\d+(\.\d{1,6})?$/.test(String(tier.priceUsd));
    const priceAtomic = priceOk ? parseUsdPrice(String(tier.priceUsd)).amount : 0n;
    if (!priceOk || priceAtomic <= 0n) {
      throw new Error(`invalid SESSION_TIERS.${name}.priceUsd: ${String(tier.priceUsd)}`);
    }
    if (!Number.isSafeInteger(tier.durationSeconds) || tier.durationSeconds < MIN_LEASE_SECONDS || tier.durationSeconds > MAX_LEASE_SECONDS) {
      throw new Error(`invalid SESSION_TIERS.${name}.durationSeconds: ${tier.durationSeconds}`);
    }
    for (const field of ["cpuMillis", "memoryMiB", "diskMiB"] as const) {
      if (!Number.isSafeInteger(tier[field]) || tier[field] <= 0) {
        throw new Error(`invalid SESSION_TIERS.${name}.${field}: ${String(tier[field])}`);
      }
    }
  }
  return out;
}

export type SpecResolution = { ok: true; spec: SessionSpec; priceUsd: string } | { ok: false; code: string; message: string };

/**
 * Resolve a create request into a concrete, immutable session spec.
 * Rejects tiers/durations/limits outside the platform policy.
 */
export function resolveSessionSpec(
  req: CreateSessionRequest,
  tiers: TierTable,
  limits: PlatformLimits,
): SpecResolution {
  // Reject an unknown runtime before pricing, capacity or payment. The guest
  // cannot load a profile that is not shipped, and a paid session must never
  // be created for one.
  const runtime = resolveRuntime(req.runtime);
  if (!runtime.ok) return { ok: false, code: runtime.code, message: runtime.message };

  const tier = (req.tier ?? "standard") as SessionTier;

  let durationSeconds: number;
  let cpuMillis: number;
  let memoryMiB: number;
  let diskMiB: number;
  let priceUsd: string;

  if (tier !== "custom") {
    const def = tiers[tier as keyof TierTable];
    if (!def) return { ok: false, code: "unknown_tier", message: `unknown tier ${tier}` };
    if (req.durationSeconds !== undefined && req.durationSeconds !== def.durationSeconds) {
      return {
        ok: false,
        code: "tier_duration_mismatch",
        message: `tier ${tier} has a fixed duration of ${def.durationSeconds}s`,
      };
    }
    durationSeconds = def.durationSeconds;
    cpuMillis = def.cpuMillis;
    memoryMiB = def.memoryMiB;
    diskMiB = def.diskMiB;
    priceUsd = def.priceUsd;
  } else {
    if (!limits.allowCustom) {
      return { ok: false, code: "custom_not_allowed", message: "custom sessions are disabled on this deployment" };
    }
    if (req.durationSeconds === undefined) {
      return { ok: false, code: "duration_required", message: "custom sessions require durationSeconds" };
    }
    durationSeconds = Math.trunc(req.durationSeconds);
    cpuMillis = Math.trunc(req.cpuMillis ?? tiers.standard.cpuMillis);
    memoryMiB = Math.trunc(req.memoryMiB ?? tiers.standard.memoryMiB);
    diskMiB = Math.trunc(req.diskMiB ?? tiers.standard.diskMiB);
    // Price both axes. A custom session used to cost only by duration, so
    // 4 vCPU / 8 GiB and 100m / 128 MiB at the same duration were identical.
    // `units` is the largest resource ratio against the standard tier, floored
    // at a quarter so a tiny session is cheaper than standard rather than free.
    const base = tiers.standard;
    const durationFactor = Math.max(0.01, durationSeconds / base.durationSeconds);
    const units = Math.max(
      0.25,
      cpuMillis / base.cpuMillis,
      memoryMiB / base.memoryMiB,
      diskMiB / base.diskMiB,
    );
    // Integer arithmetic at 1e-6 USD; round up so a paid session never
    // under-charges by a rounding step.
    const baseAtomic = parseUsdPrice(base.priceUsd).amount;
    const factorMicros = BigInt(Math.ceil(durationFactor * units * 1_000_000));
    const atomic = (baseAtomic * factorMicros + 999_999n) / 1_000_000n;
    priceUsd = formatUsd((atomic > 0n ? atomic : 1n).toString());
  }

  if (durationSeconds < MIN_LEASE_SECONDS || durationSeconds > limits.maxLeaseSeconds) {
    return {
      ok: false,
      code: "invalid_duration",
      message: `duration must be between ${MIN_LEASE_SECONDS} and ${limits.maxLeaseSeconds} seconds`,
    };
  }
  if (cpuMillis < 100 || cpuMillis > limits.maxCpuMillis) {
    return { ok: false, code: "invalid_cpu", message: `cpuMillis must be between 100 and ${limits.maxCpuMillis}` };
  }
  if (memoryMiB < 128 || memoryMiB > limits.maxMemoryMiB) {
    return { ok: false, code: "invalid_memory", message: `memoryMiB must be between 128 and ${limits.maxMemoryMiB}` };
  }
  if (diskMiB < 16 || diskMiB > limits.maxDiskMiB) {
    return { ok: false, code: "invalid_disk", message: `diskMiB must be between 16 and ${limits.maxDiskMiB}` };
  }

  const sessionLimits: SessionLimits = {
    cpuMillis,
    memoryMiB,
    diskMiB,
    maxOutputBytes: limits.maxOutputBytes,
    maxFileBytes: limits.maxFileBytes,
    maxCommandSeconds: Math.min(limits.maxCommandSeconds, durationSeconds),
    maxProcesses: limits.maxProcesses,
  };

  // Optional checkpoint/resume policy. Normalize defaults so the spec hash is
  // stable between the API and the controller.
  let idlePolicy: SessionSpec["idlePolicy"];
  let maxLifetimeSeconds: number | undefined;
  if (req.idlePolicy) {
    const maxIdleSeconds = Math.trunc(req.idlePolicy.maxIdleSeconds ?? 300);
    const suspendedDurationSeconds = Math.trunc(req.idlePolicy.suspendedDurationSeconds ?? MAX_SESSION_LIFETIME_SECONDS);
    if (maxIdleSeconds < 1 || maxIdleSeconds > MAX_SESSION_LIFETIME_SECONDS) {
      return {
        ok: false,
        code: "invalid_idle_policy",
        message: `maxIdleSeconds must be between 1 and ${MAX_SESSION_LIFETIME_SECONDS}`,
      };
    }
    if (suspendedDurationSeconds < 1 || suspendedDurationSeconds > MAX_SESSION_LIFETIME_SECONDS) {
      return {
        ok: false,
        code: "invalid_idle_policy",
        message: `suspendedDurationSeconds must be between 1 and ${MAX_SESSION_LIFETIME_SECONDS}`,
      };
    }
    idlePolicy = {
      maxIdleSeconds,
      suspendedDurationSeconds,
      autoResume: req.idlePolicy.autoResume ?? true,
    };
    maxLifetimeSeconds = Math.trunc(req.maxLifetimeSeconds ?? MAX_SESSION_LIFETIME_SECONDS);
  } else if (req.maxLifetimeSeconds !== undefined) {
    maxLifetimeSeconds = Math.trunc(req.maxLifetimeSeconds);
  }
  if (maxLifetimeSeconds !== undefined) {
    if (maxLifetimeSeconds < durationSeconds || maxLifetimeSeconds > MAX_SESSION_LIFETIME_SECONDS) {
      return {
        ok: false,
        code: "invalid_max_lifetime",
        message: `maxLifetimeSeconds must be between the lease duration and ${MAX_SESSION_LIFETIME_SECONDS}`,
      };
    }
  }

  // Baseline is the scheduler reservation; peak stays in `limits`. Default is
  // the historical pod request (peak/4) so existing tiers keep their density.
  const baselineCpuMillis = Math.trunc(req.baselineCpuMillis ?? Math.max(50, cpuMillis / 4));
  const baselineMemoryMiB = Math.trunc(req.baselineMemoryMiB ?? Math.max(64, memoryMiB / 4));
  if (baselineCpuMillis < 50 || baselineCpuMillis > cpuMillis) {
    return {
      ok: false,
      code: "invalid_baseline",
      message: "baselineCpuMillis must be between 50 and the peak cpuMillis",
    };
  }
  if (baselineMemoryMiB < 64 || baselineMemoryMiB > memoryMiB) {
    return {
      ok: false,
      code: "invalid_baseline",
      message: "baselineMemoryMiB must be between 64 and the peak memoryMiB",
    };
  }

  return {
    ok: true,
    spec: {
      tier,
      durationSeconds,
      limits: sessionLimits,
      runtime: runtime.runtime,
      baseline: { cpuMillis: baselineCpuMillis, memoryMiB: baselineMemoryMiB },
      ...(idlePolicy ? { idlePolicy } : {}),
      ...(maxLifetimeSeconds !== undefined ? { maxLifetimeSeconds } : {}),
      ...(req.clientPublicKey && req.clientNonce
        ? { clientCommitment: { publicKey: req.clientPublicKey, nonce: req.clientNonce } }
        : {}),
    },
    priceUsd,
  };
}

/** Stable identity of a requested spec, used to bind a payment to it. */
export function specHash(spec: SessionSpec): string {
  return sha256Hex(canonicalJson(spec));
}
