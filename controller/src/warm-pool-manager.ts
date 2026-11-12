/**
 * Elastic warm-pool manager.
 *
 * Owns one {@link WarmPool} per runtime profile and a single total budget
 * (`WARM_POOL_SIZE`). `base` holds a configurable minimum; language profiles
 * start at zero and earn capacity from observed misses. Capacity is moved, not
 * created: a growing profile takes free budget first and only then drains an
 * idle profile, never a profile that is currently serving claims.
 *
 * The demand model is deliberately crude and deterministic: a miss is one unit
 * of demand that decays linearly over `WARM_POOL_DEMAND_WINDOW_MS`. No
 * prediction, no history beyond the current window, and every decision is a
 * pure function of counters plus the clock, so a test can drive it directly.
 */
import { log, metrics } from "@x402s/shared/runtime";
import type { RuntimeProfile } from "./config.js";
import { DEFAULT_RUNTIME_PROFILE, sessionRuntime } from "./config.js";
import type { WarmPodInfo } from "./k8s.js";
import type { ReconcilerContext } from "./reconciler-context.js";
import type { SessionRecord } from "./store/models.js";
import { WarmPool, type WarmClaimOutcome } from "./warm-pool.js";

/** Pods the whole manager may create per reconcile pass. */
const MAX_CREATE_PER_PASS = 2;

interface ProfilePoolStats {
  profile: string;
  /** Desired idle pods for this profile. */
  target: number;
  hits: number;
  misses: number;
  /** Misses caused by the session shape, which more pods cannot fix. */
  limitMisses: number;
  /** Decayed demand units at the last observation. */
  lastDemand: number;
}

interface ProfilePoolState {
  profile: string;
  target: number;
  hits: number;
  misses: number;
  limitMisses: number;
  /** Demand units as of `lastMissAt`; see `demandScore`. */
  demand: number;
  lastMissAt: number | null;
  lastHitAt: number | null;
  lastGrowthAt: number | null;
  lastDrainAt: number | null;
}

export class WarmPoolManager {
  private readonly pools = new Map<string, WarmPool>();
  private readonly state = new Map<string, ProfilePoolState>();
  /** Order is stable: `base` first, then catalog order. */
  private readonly order: string[] = [];

  constructor(private readonly ctx: ReconcilerContext) {
    for (const profile of Object.values(ctx.cfg.runtimeProfiles)) {
      this.register(profile);
    }
    // A catalog is always built with base, but a hand-built one may omit it.
    const base = ctx.cfg.runtimeProfiles[DEFAULT_RUNTIME_PROFILE];
    if (base && !this.pools.has(base.name)) this.register(base);
    this.applyMinimum();
  }

  private register(profile: RuntimeProfile): void {
    this.pools.set(profile.name, new WarmPool(this.ctx, profile));
    this.state.set(profile.name, {
      profile: profile.name,
      target: 0,
      hits: 0,
      misses: 0,
      limitMisses: 0,
      demand: 0,
      lastMissAt: null,
      lastHitAt: null,
      lastGrowthAt: null,
      lastDrainAt: null,
    });
    this.order.push(profile.name);
  }

  private applyMinimum(): void {
    const base = this.state.get(DEFAULT_RUNTIME_PROFILE);
    if (!base) return;
    base.target = Math.min(this.ctx.cfg.warmPoolBaseMin, this.ctx.cfg.warmPoolSize);
  }

  /** Desired sizes, for tests and diagnostics. */
  targets(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of this.order) out[name] = this.state.get(name)!.target;
    return out;
  }

  stats(): Record<string, ProfilePoolStats> {
    const now = this.ctx.now();
    const out: Record<string, ProfilePoolStats> = {};
    for (const name of this.order) {
      const st = this.state.get(name)!;
      out[name] = {
        profile: st.profile,
        target: st.target,
        hits: st.hits,
        misses: st.misses,
        limitMisses: st.limitMisses,
        lastDemand: this.demandScore(st, now),
      };
    }
    return out;
  }

  /**
   * Claim a warm pod for this session from the pool matching its runtime.
   *
   * Returns false whenever no pod was claimed; the caller then takes the cold
   * path. A miss is recorded per profile so the pool can grow next pass.
   */
  async tryClaim(
    session: SessionRecord,
    relayAddr: { host: string; port: number },
    proxyAddr: { host: string; port: number },
    provisionBeginAt: number,
  ): Promise<boolean> {
    const requested = sessionRuntime(session);
    const pool = this.pools.get(requested);
    if (!pool) {
      // Never route an unknown profile to `base`: the session asked for a
      // runtime this controller does not run.
      metrics
        .counter("sandbox_warm_pool_total", "Warm pool claim outcomes")
        .inc({ result: "miss_unknown_profile", profile: "unknown" });
      // Bounded: this value comes from a client request.
      log.warn("warm_pool_profile_unknown", { runtime: requested.slice(0, 64) });
      return false;
    }
    const outcome = await pool.tryClaim(session, relayAddr, proxyAddr, provisionBeginAt);
    this.record(requested, outcome, this.ctx.now());
    return outcome === "hit";
  }

  private record(profile: string, outcome: WarmClaimOutcome, now: number): void {
    const st = this.state.get(profile);
    if (!st) return;
    switch (outcome) {
      case "hit":
        st.hits++;
        st.lastHitAt = now;
        return;
      case "miss_empty":
        st.misses++;
        // Accumulate decayed demand, then count this miss.
        st.demand = this.demandScore(st, now) + 1;
        st.lastMissAt = now;
        this.maybeGrow(st, now);
        return;
      case "miss_limits":
        // More pods would not have helped this session; do not grow on it.
        st.limitMisses++;
        return;
      case "miss_error":
        // A handoff failed after a pod was already picked: growing would only
        // add pods that fail the same way.
        return;
      default:
        return;
    }
  }

  /**
   * Decayed demand for a profile: one miss is worth one unit at the moment it
   * happens, falling linearly to zero across the demand window.
   */
  private demandScore(st: ProfilePoolState, now: number): number {
    if (st.lastMissAt === null) return 0;
    const window = Math.max(1, this.ctx.cfg.warmPoolDemandWindowMs);
    const elapsed = Math.max(0, now - st.lastMissAt);
    if (elapsed >= window) return 0;
    // `demand` is the accumulated value as of `lastMissAt`, so this read is
    // pure: a later miss folds the decay in when it stores the new value.
    return st.demand * (1 - elapsed / window);
  }

  /** Minimum size a profile may be drained to. */
  private floorFor(profile: string): number {
    return profile === DEFAULT_RUNTIME_PROFILE
      ? Math.min(this.ctx.cfg.warmPoolBaseMin, this.ctx.cfg.warmPoolSize)
      : 0;
  }

  private usedBudget(): number {
    let used = 0;
    for (const name of this.order) used += this.state.get(name)!.target;
    return used;
  }

  private freeBudget(): number {
    return Math.max(0, this.ctx.cfg.warmPoolSize - this.usedBudget());
  }

  /**
   * Grow the pool that just missed, if the cooldown allows it.
   *
   * Free budget is spent first. When there is none, one or more idle profiles
   * are drained to fund the move; a profile that is actively serving claims is
   * never a victim.
   */
  private maybeGrow(st: ProfilePoolState, now: number): void {
    const cfg = this.ctx.cfg;
    if (cfg.warmPoolSize === 0) return;
    if (st.lastGrowthAt !== null && now - st.lastGrowthAt < cfg.warmPoolCooldownMs) {
      metrics
        .counter("sandbox_warm_pool_grow_total", "Warm pool growth decisions")
        .inc({ profile: st.profile, result: "cooldown" });
      return;
    }
    const step = Math.max(1, Math.min(cfg.warmPoolGrowthStep, cfg.warmPoolSize));
    const free = this.freeBudget();
    if (free > 0) {
      const grow = Math.min(step, free);
      st.target += grow;
      st.lastGrowthAt = now;
      metrics
        .counter("sandbox_warm_pool_grow_total", "Warm pool growth decisions")
        .inc({ profile: st.profile, result: "budget" });
      log.info("warm_pool_grown", { runtime: st.profile, pods: grow, target: st.target });
      return;
    }

    const victim = this.idleVictim(st.profile, now);
    if (!victim) {
      metrics
        .counter("sandbox_warm_pool_grow_total", "Warm pool growth decisions")
        .inc({ profile: st.profile, result: "budget_exhausted" });
      log.info("warm_pool_growth_blocked", { runtime: st.profile, reason: "budget_exhausted" });
      return;
    }
    const headroom = victim.target - this.floorFor(victim.profile);
    const moved = Math.min(step, headroom);
    victim.target -= moved;
    victim.lastDrainAt = now;
    st.target += moved;
    st.lastGrowthAt = now;
    metrics
      .counter("sandbox_warm_pool_grow_total", "Warm pool growth decisions")
      .inc({ profile: st.profile, result: "steal" });
    log.info("warm_pool_reallocated", {
      from: victim.profile,
      to: st.profile,
      pods: moved,
    });
  }

  /**
   * The idlest profile that may lose a pod: above its floor, no demand in the
   * window, and untouched for at least `WARM_POOL_IDLE_DRAIN_MS`. Ties break
   * on the larger pool, then on name, so the choice is reproducible.
   */
  private idleVictim(requester: string, now: number): ProfilePoolState | null {
    const cfg = this.ctx.cfg;
    const candidates = this.order
      .filter((name) => name !== requester)
      .map((name) => this.state.get(name)!)
      .filter((st) => st.target > this.floorFor(st.profile))
      .filter((st) => this.demandScore(st, now) === 0)
      .filter((st) => {
        const lastUsed = Math.max(st.lastHitAt ?? 0, st.lastMissAt ?? 0, st.lastGrowthAt ?? 0);
        return now - lastUsed >= cfg.warmPoolIdleDrainMs;
      });
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) => b.target - a.target || (a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0),
    );
    return candidates[0]!;
  }

  /**
   * Give back one pod from a profile that has been quiet for the drain grace.
   * One pod per pass: shrinking is deliberately slower than growing so a burst
   * of misses cannot turn into an oscillation.
   */
  private maybeShrink(st: ProfilePoolState, now: number): void {
    const cfg = this.ctx.cfg;
    const floor = this.floorFor(st.profile);
    if (st.target <= floor) return;
    if (this.demandScore(st, now) > 0) return;
    const quietSince = Math.max(st.lastHitAt ?? 0, st.lastMissAt ?? 0, st.lastGrowthAt ?? 0);
    if (now - quietSince < cfg.warmPoolIdleDrainMs) return;
    if (st.lastDrainAt !== null && now - st.lastDrainAt < cfg.warmPoolCooldownMs) return;
    st.target -= 1;
    st.lastDrainAt = now;
    metrics
      .counter("sandbox_warm_pool_drain_total", "Warm pool idle drains")
      .inc({ profile: st.profile, reason: "idle" });
    log.info("warm_pool_drained", { runtime: st.profile, target: st.target });
  }

  /** Keep the invariant that allocations never exceed the shared budget. */
  private normalizeAllocation(): void {
    const budget = this.ctx.cfg.warmPoolSize;
    let over = this.usedBudget() - budget;
    if (over <= 0) return;
    // Shed non-base pools first, largest first, then base down to its floor.
    const drainable = this.order
      .filter((name) => this.state.get(name)!.target > this.floorFor(name))
      .sort((a, b) => {
        if (a === DEFAULT_RUNTIME_PROFILE) return 1;
        if (b === DEFAULT_RUNTIME_PROFILE) return -1;
        return this.state.get(b)!.target - this.state.get(a)!.target;
      });
    for (const name of drainable) {
      if (over <= 0) break;
      const st = this.state.get(name)!;
      const give = Math.min(over, st.target - this.floorFor(name));
      st.target -= give;
      over -= give;
      log.warn("warm_pool_allocation_clamped", { runtime: name, target: st.target });
    }
  }

  /**
   * Recycle, trim and replenish every profile pool against one shared budget
   * and one namespace listing.
   */
  async reconcile(): Promise<void> {
    const cfg = this.ctx.cfg;
    this.normalizeAllocation();
    const now = this.ctx.now();

    let pods: WarmPodInfo[];
    try {
      pods = await this.ctx.provisioner.listWarmPods();
    } catch (err) {
      log.warn("warm_pool_list_failed", { error: (err as Error).message });
      return;
    }

    const byProfile = new Map<string, WarmPodInfo[]>();
    for (const pod of pods) {
      const list = byProfile.get(pod.runtime);
      if (list) list.push(pod);
      else byProfile.set(pod.runtime, [pod]);
    }

    // Pods of a profile this controller no longer runs, or from before profiles
    // existed, can never be claimed. Drain them here rather than letting them
    // age out: they hold real cluster capacity.
    for (const [runtime, orphans] of byProfile) {
      if (this.pools.has(runtime)) continue;
      for (const pod of orphans) {
        if (!pod.warmId) continue;
        await this.ctx.provisioner.deletePod(pod.name, 0).catch(() => undefined);
        await this.ctx.relay.purge(pod.poolId).catch(() => undefined);
        log.info("warm_pod_recycled", {
          podName: pod.name,
          runtime: runtime === "" ? "unknown" : runtime,
          reason: "unknown_profile",
        });
      }
      byProfile.delete(runtime);
    }

    // Reclaim idle headroom before any pool refills, so a shrunken profile's
    // pods are not replaced from the same budget on the next pass.
    for (const name of this.order) this.maybeShrink(this.state.get(name)!, now);

    let relayAddr: { host: string; port: number } | undefined;
    let proxyAddr: { host: string; port: number } | undefined;
    // Nothing to create when every pool is drained (the `WARM_POOL_SIZE=0`
    // case): skip the service lookups entirely, as the single pool did.
    const anyWanted = this.order.some((name) => this.state.get(name)!.target > 0);
    if (cfg.warmPoolSize > 0 && anyWanted) {
      relayAddr = (await this.ctx.serviceAddress(cfg.relayServiceName)) ?? undefined;
      proxyAddr = (await this.ctx.serviceAddress(cfg.proxyServiceName)) ?? undefined;
    }

    let createBudget = MAX_CREATE_PER_PASS;
    for (const name of this.order) {
      const st = this.state.get(name)!;
      const pool = this.pools.get(name)!;
      createBudget = await pool.reconcile(byProfile.get(name) ?? [], {
        target: st.target,
        maxCreate: createBudget,
        ...(relayAddr ? { relayAddr } : {}),
        ...(proxyAddr ? { proxyAddr } : {}),
      });
      metrics
        .gauge("sandbox_warm_pool_budget", "Warm pool target size")
        .set({ profile: name }, st.target);
    }
  }

  /** Warm pool for a profile, for tests and diagnostics. */
  poolFor(profile: string): WarmPool | undefined {
    return this.pools.get(profile);
  }
}
