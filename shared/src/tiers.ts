/**
 * Session tiers, resource limits and lease validation.
 *
 * One table shared by the API (pricing + validation), the controller (limits)
 * and the SDK. Environment overrides let a deployment change prices/limits
 * without code changes; hard caps are enforced regardless.
 */
import { canonicalJson, sha256Hex } from "./crypto.js";
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

function int(v: string | undefined, def: number): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

export function loadPlatformLimits(env: NodeJS.ProcessEnv = process.env): PlatformLimits {
  return {
    maxLeaseSeconds: Math.min(MAX_LEASE_SECONDS, int(env.MAX_LEASE_SECONDS, MAX_LEASE_SECONDS)),
    maxCpuMillis: int(env.MAX_CPU_MILLIS, 4000),
    maxMemoryMiB: int(env.MAX_MEMORY_MIB, 8192),
    maxDiskMiB: int(env.MAX_DISK_MIB, 8192),
    maxOutputBytes: int(env.MAX_OUTPUT_BYTES, 256 * 1024),
    maxFileBytes: int(env.MAX_FILE_BYTES, 8 * 1024 * 1024),
    maxCommandSeconds: int(env.MAX_COMMAND_SECONDS, 300),
    maxProcesses: int(env.MAX_PROCESSES, 256),
    allowCustom: (env.ALLOW_CUSTOM_DURATIONS ?? "true").toLowerCase() !== "false",
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
    const base = tiers.standard;
    const factor = Math.max(0.1, durationSeconds / base.durationSeconds);
    const basePrice = Number(String(base.priceUsd).replace("$", "")) || 0.05;
    priceUsd = `$${(basePrice * factor).toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00")}`;
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
      return { ok: false, code: "invalid_idle_policy", message: "maxIdleSeconds must be between 1 and 28800" };
    }
    if (suspendedDurationSeconds < 1 || suspendedDurationSeconds > MAX_SESSION_LIFETIME_SECONDS) {
      return {
        ok: false,
        code: "invalid_idle_policy",
        message: "suspendedDurationSeconds must be between 1 and 28800",
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
      baseline: { cpuMillis: baselineCpuMillis, memoryMiB: baselineMemoryMiB },
      ...(idlePolicy ? { idlePolicy } : {}),
      ...(maxLifetimeSeconds !== undefined ? { maxLifetimeSeconds } : {}),
    },
    priceUsd,
  };
}

/** Stable identity of a requested spec, used to bind a payment to it. */
export function specHash(spec: SessionSpec): string {
  return sha256Hex(canonicalJson(spec));
}
