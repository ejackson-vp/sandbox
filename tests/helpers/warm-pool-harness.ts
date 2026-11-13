/**
 * A fake warm-pod namespace and a reference model of the allocation policy.
 *
 * The namespace applies the same observable effects as Kubernetes, because the
 * manager's arithmetic depends on them: a created pod appears in the next
 * listing, deleting one removes it, and a claim relabels the pod out of the warm
 * listing, which is what the pool counts as "claimed" rather than "live".
 *
 * The model is the documented growth/shrink policy stated independently of
 * `WarmPoolManager`: floors, one shared budget spent before any profile is
 * drained, linear demand decay, the growth cooldown, and the victim rule
 * (largest target first, then profile name). Property tests drive the manager
 * and the model with the same sequence and compare the targets, which is the
 * only way a policy made of a dozen interacting rules stays pinned.
 */
import type { ControllerConfig } from "../../controller/src/config.js";
import type { Provisioner, WarmPodSpec, WarmPodInfo } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type { ReconcilerContext } from "../../controller/src/reconciler-context.js";
import { DEFAULT_RUNTIME_PROFILE } from "../../controller/src/runtime-profiles.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import { WarmPoolManager } from "../../controller/src/warm-pool-manager.js";
import { controllerConfig } from "./controller-config.js";
import { limitsFor, sessionFixture } from "./store-fixtures.js";

const NOW = 1_000_000;
export const DIGEST = `sha256:${"a".repeat(64)}`;
export const BASE = DEFAULT_RUNTIME_PROFILE;
export const PYTHON = "python";
export const NODE = "node";

function managerConfig(env: NodeJS.ProcessEnv = {}): ControllerConfig {
  return controllerConfig({
    WARM_POOL_SIZE: "4",
    WARM_POOL_BASE_MIN: "1",
    WARM_POOL_TIER: "short",
    WARM_POOL_GROWTH_STEP: "1",
    WARM_POOL_COOLDOWN_MS: "15000",
    WARM_POOL_IDLE_DRAIN_MS: "60000",
    WARM_POOL_DEMAND_WINDOW_MS: "120000",
    RUNTIME_PROFILES: JSON.stringify({
      [PYTHON]: { image: "guest-python", digest: DIGEST },
      [NODE]: { image: "guest-node", digest: DIGEST },
    }),
    ...env,
  });
}

export function harness(env: NodeJS.ProcessEnv = {}) {
  const cfg = managerConfig(env);
  const clock = { now: NOW };
  const pods: WarmPodInfo[] = [];
  const deletes: string[] = [];
  const creates: WarmPodSpec[] = [];
  const purges: string[] = [];
  let listFails = false;
  let admitted = true;
  /** Set by `parkClaim`: the next `relay.claim` parks until it is released. */
  let claimGate: { promise: Promise<void>; enter(): void } | null = null;

  const provisioner = {
    listWarmPods: async () => {
      if (listFails) throw new Error("apiserver unavailable");
      return pods.map((pod) => ({ ...pod }));
    },
    createWarmPod: async (spec: WarmPodSpec) => {
      creates.push(spec);
      pods.push({
        name: `warm-${spec.warmId}`,
        warmId: spec.warmId,
        poolId: spec.poolId,
        createdAt: clock.now,
        phase: "Running",
        runtime: spec.runtime,
        identity: spec.identity,
        imageDigest: spec.imageDigest,
      });
      return { podName: `warm-${spec.warmId}` };
    },
    deletePod: async (name: string) => {
      deletes.push(name);
      const index = pods.findIndex((pod) => pod.name === name);
      if (index >= 0) pods.splice(index, 1);
    },
    patchPodLabels: async (name: string, labels: Record<string, string | null>) => {
      // A claimed pod is a sandbox pod: the warm listing stops returning it.
      if (labels["x402.io/pool"] !== "sandbox") return;
      const index = pods.findIndex((pod) => pod.name === name);
      if (index >= 0) pods.splice(index, 1);
    },
  } as unknown as Provisioner;

  const relay = {
    state: async () => ({
      registered: true,
      connected: true,
      attestation: { sessionId: "warm_pool" },
      pending: 0,
    }),
    registerCurrent: async () => ({ generation: "test", attempts: 1 }),
    claim: async () => {
      if (!claimGate) return;
      claimGate.enter();
      await claimGate.promise;
    },
    purge: async (key: string) => {
      purges.push(key);
    },
  } as unknown as RelayClient;

  const capacity = {
    preflight: async () => ({ admitted, reason: admitted ? "ok" : "no_room" }),
    pinSessionNode: async () => true,
  } as unknown as ReconcilerContext["capacity"];

  const store = {
    setProvisioning: async () => true,
    setRelayToken: async () => undefined,
    mergeTimings: async () => undefined,
  } as unknown as ReconcilerContext["store"];

  const ctx = {
    cfg,
    store,
    provisioner,
    relay,
    capacity,
    snapshotter: {},
    now: () => clock.now,
    serviceAddress: async () => ({ host: "proxy", port: 3128 }),
    stableServiceAddress: async () => ({ host: "relay", port: 8443 }),
  } as unknown as ReconcilerContext;

  const manager = new WarmPoolManager(ctx);
  const sequence = { next: 0 };

  const session = (runtime: string, overrides: Partial<SessionRecord> = {}): SessionRecord =>
    sessionFixture({
      id: `sbx_warm_${sequence.next++}`,
      paymentKey: `payment-warm-${sequence.next}`,
      tier: "standard",
      durationSeconds: 300,
      limits: manager.poolFor(runtime)?.limits() ?? limitsFor("unit"),
      clientPublicKey: "pk".repeat(22),
      clientNonce: "nn".repeat(22),
      now: clock.now,
      runtime: runtime as SessionRecord["runtime"],
      overrides,
    });

  const claim = (runtime: string, overrides: Partial<SessionRecord> = {}) =>
    manager.tryClaim(
      session(runtime, overrides),
      { host: "relay", port: 8443 },
      { host: "proxy", port: 3128 },
      clock.now,
    );

  return {
    cfg,
    clock,
    manager,
    claim,
    pods,
    deletes,
    creates,
    purges,
    refuseList: () => {
      listFails = true;
    },
    refuseAdmission: () => {
      admitted = false;
    },
    /** Park the next claim after the pod is reserved, to model an in-flight handoff. */
    parkClaim: async (runtime: string) => {
      let release!: () => void;
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      claimGate = {
        promise: new Promise<void>((resolve) => {
          release = resolve;
        }),
        enter,
      };
      const result = claim(runtime);
      // Fail with the reason rather than waiting out the test timeout when the
      // claim never reaches the relay (no claimable pod, so nothing to park).
      const reached = await Promise.race([entered.then(() => true), result.then(() => false)]);
      if (!reached) throw new Error("claim finished without reaching the relay");
      return {
        result,
        finish: () => {
          release();
          claimGate = null;
        },
      };
    },
    podsFor: (runtime: string) => pods.filter((pod) => pod.runtime === runtime),
    targets: () => manager.targets(),
  };
}

/** One profile's allocation state, as the module documents it. */
interface RefState {
  profile: string;
  target: number;
  demand: number;
  lastMissAt: number | null;
  lastHitAt: number | null;
  lastGrowthAt: number | null;
  lastDrainAt: number | null;
}

/**
 * The documented allocation policy, independent of the implementation: the
 * budget and floor arithmetic, linear demand decay, the growth cooldown, the
 * free-budget-then-steal order and the "largest, then name" victim tie-break.
 */
export class AllocationModel {
  private readonly state = new Map<string, RefState>();
  readonly order: string[];

  constructor(
    private readonly cfg: ControllerConfig,
    order: string[],
  ) {
    this.order = order;
    for (const profile of order) {
      this.state.set(profile, {
        profile,
        target: 0,
        demand: 0,
        lastMissAt: null,
        lastHitAt: null,
        lastGrowthAt: null,
        lastDrainAt: null,
      });
    }
    const base = this.state.get(BASE);
    if (base) base.target = Math.min(cfg.warmPoolBaseMin, cfg.warmPoolSize);
  }

  targets(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const profile of this.order) out[profile] = this.state.get(profile)!.target;
    return out;
  }

  used(): number {
    return this.order.reduce((sum, profile) => sum + this.state.get(profile)!.target, 0);
  }

  private floorFor(profile: string): number {
    return profile === BASE ? Math.min(this.cfg.warmPoolBaseMin, this.cfg.warmPoolSize) : 0;
  }

  private demandScore(st: RefState, now: number): number {
    if (st.lastMissAt === null) return 0;
    const window = Math.max(1, this.cfg.warmPoolDemandWindowMs);
    const elapsed = Math.max(0, now - st.lastMissAt);
    if (elapsed >= window) return 0;
    return st.demand * (1 - elapsed / window);
  }

  /** Record a claim outcome; `hit` only touches the last-used time. */
  record(profile: string, outcome: "hit" | "miss", now: number): void {
    const st = this.state.get(profile);
    if (!st) return;
    if (outcome === "hit") {
      st.lastHitAt = now;
      return;
    }
    st.demand = this.demandScore(st, now) + 1;
    st.lastMissAt = now;
    this.grow(st, now);
  }

  private grow(st: RefState, now: number): void {
    const cfg = this.cfg;
    if (cfg.warmPoolSize === 0) return;
    if (st.lastGrowthAt !== null && now - st.lastGrowthAt < cfg.warmPoolCooldownMs) return;
    const step = Math.max(1, Math.min(cfg.warmPoolGrowthStep, cfg.warmPoolSize));
    const free = Math.max(0, cfg.warmPoolSize - this.used());
    if (free > 0) {
      st.target += Math.min(step, free);
      st.lastGrowthAt = now;
      return;
    }
    const victim = this.idleVictim(st.profile, now);
    if (!victim) return;
    const moved = Math.min(step, victim.target - this.floorFor(victim.profile));
    victim.target -= moved;
    victim.lastDrainAt = now;
    st.target += moved;
    st.lastGrowthAt = now;
  }

  private idleVictim(requester: string, now: number): RefState | null {
    const cfg = this.cfg;
    const candidates = this.order
      .filter((profile) => profile !== requester)
      .map((profile) => this.state.get(profile)!)
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

  private shrink(st: RefState, now: number): void {
    const cfg = this.cfg;
    const floor = this.floorFor(st.profile);
    if (st.target <= floor) return;
    if (this.demandScore(st, now) > 0) return;
    const quietSince = Math.max(st.lastHitAt ?? 0, st.lastMissAt ?? 0, st.lastGrowthAt ?? 0);
    if (now - quietSince < cfg.warmPoolIdleDrainMs) return;
    if (st.lastDrainAt !== null && now - st.lastDrainAt < cfg.warmPoolCooldownMs) return;
    st.target -= 1;
    st.lastDrainAt = now;
  }

  normalize(): void {
    const budget = this.cfg.warmPoolSize;
    let over = this.used() - budget;
    if (over <= 0) return;
    const drainable = this.order
      .filter((profile) => this.state.get(profile)!.target > this.floorFor(profile))
      .sort((a, b) => {
        if (a === BASE) return 1;
        if (b === BASE) return -1;
        return this.state.get(b)!.target - this.state.get(a)!.target;
      });
    for (const profile of drainable) {
      if (over <= 0) break;
      const st = this.state.get(profile)!;
      const give = Math.min(over, st.target - this.floorFor(profile));
      st.target -= give;
      over -= give;
    }
  }

  reconcile(now: number): void {
    this.normalize();
    for (const profile of this.order) this.shrink(this.state.get(profile)!, now);
  }
}

/**
 * The clamp on its own: shed non-base profiles largest-first, then base down to
 * its floor. Kept separate from the full model because it is the only part of
 * the policy a shrinking budget exercises, and the full model needs the history
 * that the shrink rules read.
 */
export function shed(
  targets: Record<string, number>,
  budget: number,
  baseMin: number,
): Record<string, number> {
  const out = { ...targets };
  const floorFor = (profile: string): number => (profile === BASE ? Math.min(baseMin, budget) : 0);
  let over = Object.values(out).reduce((sum, value) => sum + value, 0) - budget;
  if (over > 0) {
    const drainable = Object.keys(out)
      .filter((profile) => out[profile]! > floorFor(profile))
      .sort((a, b) => {
        if (a === BASE) return 1;
        if (b === BASE) return -1;
        return out[b]! - out[a]!;
      });
    for (const profile of drainable) {
      if (over <= 0) break;
      const give = Math.min(over, out[profile]! - floorFor(profile));
      out[profile]! -= give;
      over -= give;
    }
  }
  return out;
}

/** A running warm pod with the identity a pool requires to claim it. */
export function warmPod(
  name: string,
  warmId: string,
  runtime: string,
  identity: string,
  digest: string,
  createdAt: number,
): WarmPodInfo {
  return {
    name,
    warmId,
    poolId: `warm_${warmId}`,
    createdAt,
    phase: "Running",
    runtime,
    identity,
    imageDigest: digest,
  };
}
