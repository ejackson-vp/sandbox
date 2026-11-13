/**
 * Warm pool claim and capacity invariants.
 *
 * The pool is an inventory of pre-booted pods that a paid session may take
 * exactly once. The module's header and docs/warm-pool.md make four promises
 * that no unit example can pin, because each is about a sequence or a race:
 *
 *   1. one pod is offered to at most one claim. `pick` and the reserve are one
 *      serialised step, so concurrent claims on a single pod produce exactly
 *      one winner and the rest are `miss_empty`;
 *   2. a pod is claimable only when it passed every gate: same runtime profile,
 *      same identity hash, same image digest, a live phase, inside the TTL and a
 *      relay registration that is connected and attested. A stale pod is a miss
 *      and is recycled, never handed to a customer;
 *   3. reconcile creates at most the missing pods, at most `maxCreate`, and at
 *      most `target` in total. Scale-down deletes only idle pods: a claimed pod
 *      is counted as live and is never a victim;
 *   4. `target = 0` drains the pool without creating a replacement.
 *
 * The fake namespace below applies the same observable effects as Kubernetes:
 * deleting a pod removes it from the listing, and a claim relabels it out of
 * the pool, because that label is what `listWarmPods` selects on.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { DataPlaneEndpoints } from "../../controller/src/provisioning/endpoints.js";
import type { Provisioner, WarmPodInfo, WarmPodSpec } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type { ReconcilerContext } from "../../controller/src/reconciler-context.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { WarmPool } from "../../controller/src/warm-pool.js";
import { controllerConfig } from "../helpers/controller-config.js";

const PROFILE = "base";

interface RelayState {
  registered: boolean;
  connected: boolean;
  attestation: unknown;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(options: {
  env?: NodeJS.ProcessEnv;
  pods?: WarmPodInfo[];
  relayState?: (poolId: string) => RelayState;
  capacityAdmitted?: boolean;
  /** Make one handoff step fail, to prove a failure is never a hit. */
  failAt?: "register" | "claim" | "relabel" | "provisioning";
} = {}) {
  const cfg = controllerConfig({
    WARM_POOL_SIZE: "8",
    WARM_POOL_TIER: "short",
    ...options.env,
  });
  const clock = { now: 1_000_000 };
  const pods: WarmPodInfo[] = (options.pods ?? []).map((pod) => ({ ...pod }));
  const deletes: string[] = [];
  const creates: WarmPodSpec[] = [];
  const claims: Array<{ poolId: string; sessionId: string }> = [];
  const purges: string[] = [];
  /** When set, `relay.claim` parks here so the pod stays mid-claim. */
  let claimGate: Deferred<void> | null = null;
  let claimStarted: Deferred<void> | null = null;

  const provisioner = {
    listWarmPods: async () => pods.map((pod) => ({ ...pod })),
    deletePod: async (name: string) => {
      deletes.push(name);
      const index = pods.findIndex((pod) => pod.name === name);
      if (index >= 0) pods.splice(index, 1);
    },
    patchPodLabels: async (name: string, labels: Record<string, string | null>) => {
      if (options.failAt === "relabel") throw new Error("patch refused");
      // A claimed pod becomes a sandbox pod, so the warm listing no longer
      // returns it. That is the effect the real API server provides.
      if (labels["x402.io/pool"] === "sandbox") {
        const index = pods.findIndex((pod) => pod.name === name);
        if (index >= 0) pods.splice(index, 1);
      }
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
  } as unknown as Provisioner;

  const relay = {
    state: async (poolId: string) =>
      options.relayState?.(poolId) ?? {
        registered: true,
        connected: true,
        attestation: { sessionId: "warm_pool" },
        pending: 0,
      },
    registerCurrent: async () => {
      if (options.failAt === "register") throw new Error("relay unavailable");
      return { generation: "test", attempts: 1 };
    },
    claim: async (poolId: string, claim: { sessionId: string }) => {
      if (options.failAt === "claim") throw new Error("claim refused");
      claims.push({ poolId, sessionId: claim.sessionId });
      claimStarted?.resolve();
      if (claimGate) await claimGate.promise;
    },
    purge: async (key: string) => {
      purges.push(key);
    },
  } as unknown as RelayClient;

  const capacity = {
    preflight: async () => ({ admitted: options.capacityAdmitted ?? true, reason: "test" }),
    pinSessionNode: async () => true,
  } as unknown as ReconcilerContext["capacity"];

  const store = {
    setProvisioning: async () => options.failAt !== "provisioning",
    setRelayToken: async () => {},
    mergeTimings: async () => {},
  } as unknown as PostgresStore;

  const ctx: ReconcilerContext = {
    cfg,
    store,
    provisioner,
    relay,
    capacity,
    snapshotter: {} as ReconcilerContext["snapshotter"],
    now: () => clock.now,
    serviceAddress: async () => ({ host: "proxy", port: 3128 }),
    stableServiceAddress: async () => ({ host: "relay", port: 8443 }),
  };
  // One replica, so the build only ever calls `relayAddress`; null falls back
  // to the caller's endpoint, which is what the pool must use when a re-read
  // races a Service update.
  const endpoints = {
    relayAddress: async () => null,
  } as unknown as DataPlaneEndpoints;

  const profile = cfg.runtimeProfiles[PROFILE]!;
  const pool = new WarmPool(ctx, profile, endpoints);

  const session = (id: string, overrides: Partial<SessionRecord> = {}): SessionRecord =>
    ({
      id,
      limits: pool.limits(),
      durationSeconds: 300,
      clientPublicKey: "client-public-key",
      clientNonce: "client-nonce",
      baselineCpuMillis: 0,
      baselineMemoryMib: 0,
      ...overrides,
    }) as unknown as SessionRecord;

  return {
    cfg,
    clock,
    pool,
    profile,
    pods,
    deletes,
    creates,
    claims,
    purges,
    session,
    claim: (id: string, overrides: Partial<SessionRecord> = {}) =>
      pool.tryClaim(session(id, overrides), { host: "relay-pod", port: 8443 }, { host: "proxy", port: 3128 }, clock.now),
    /** Start a claim and park it after `pick` has reserved the pod. */
    claimInFlight: async (id: string) => {
      claimGate = deferred<void>();
      claimStarted = deferred<void>();
      const result = pool.tryClaim(
        session(id),
        { host: "relay-pod", port: 8443 },
        { host: "proxy", port: 3128 },
        clock.now,
      );
      await claimStarted.promise;
      return {
        result,
        finish: () => {
          claimGate?.resolve();
          claimGate = null;
        },
      };
    },
  };
}

function warmPod(
  index: number,
  identity: string,
  digest: string,
  overrides: Partial<WarmPodInfo> = {},
): WarmPodInfo {
  const warmId = index.toString(16).padStart(12, "0");
  return {
    name: `warm-${warmId}`,
    warmId,
    poolId: `warm_${warmId}`,
    createdAt: 0,
    phase: "Running",
    runtime: PROFILE,
    identity,
    imageDigest: digest,
    ...overrides,
  };
}

describe("one pod, one claim", () => {
  it("never offers the same pod to two sequential claims", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 10 }),
        async (podCount, attempts) => {
          const h = harness();
          const identity = h.pool.identity();
          for (let index = 0; index < podCount; index += 1) {
            h.pods.push(warmPod(index, identity, h.profile.digest));
          }
          const outcomes: string[] = [];
          for (let index = 0; index < attempts; index += 1) {
            outcomes.push(await h.claim(`sbx_${index}`));
          }
          const hits = outcomes.filter((outcome) => outcome === "hit");
          expect(hits).toHaveLength(Math.min(podCount, attempts));
          expect(h.claims).toHaveLength(hits.length);
          // Every claim names a different pooled pod.
          expect(new Set(h.claims.map((claim) => claim.poolId)).size).toBe(hits.length);
          expect(h.claims.map((claim) => claim.sessionId)).toEqual(
            Array.from({ length: hits.length }, (_, index) => `sbx_${index}`),
          );
        },
      ),
      { numRuns: 50 },
    );
  });

  it("gives one pod to exactly one winner under concurrent claims", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (claimants) => {
        const h = harness();
        h.pods.push(warmPod(0, h.pool.identity(), h.profile.digest));
        const outcomes = await Promise.all(
          Array.from({ length: claimants }, (_, index) => h.claim(`sbx_concurrent_${index}`)),
        );
        expect(outcomes.filter((outcome) => outcome === "hit")).toHaveLength(1);
        expect(h.claims).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome === "miss_empty")).toHaveLength(claimants - 1);
      }),
      { numRuns: 40 },
    );
  });

  it("leaves nothing claimable after the only pod is taken", async () => {
    const h = harness();
    h.pods.push(warmPod(0, h.pool.identity(), h.profile.digest));
    expect(await h.claim("sbx_first")).toBe("hit");
    expect(await h.claim("sbx_second")).toBe("miss_empty");
    expect(h.claims).toHaveLength(1);
  });
});

describe("claimability is every gate at once", () => {
  it("claims a pod if and only if it matches the profile, identity, digest, phase, age and relay state", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          runtime: fc.constantFrom(PROFILE, "python", ""),
          identityMatches: fc.boolean(),
          digestMatches: fc.boolean(),
          phase: fc.constantFrom("Running", "Pending", "Succeeded", "Failed"),
          createdAt: fc.constantFrom(0, 1_000_000, 1_000_000 - 300_001, 1_000_000 - 100_000),
          relay: fc.record({
            registered: fc.boolean(),
            connected: fc.boolean(),
            attested: fc.boolean(),
          }),
        }),
        async (variant) => {
          const relay = {
            registered: variant.relay.registered,
            connected: variant.relay.connected,
            attestation: variant.relay.attested ? { sessionId: "warm_pool" } : null,
          };
          const h = harness({ relayState: () => relay });
          const now = h.clock.now;
          const identity = variant.identityMatches ? h.pool.identity() : "stale-identity";
          const digest = variant.digestMatches ? h.profile.digest : `sha256:${"b".repeat(64)}`;
          const pod = warmPod(0, identity, digest, {
            runtime: variant.runtime,
            phase: variant.phase,
            createdAt: variant.createdAt,
          });
          h.pods.push(pod);
          const agedOut = variant.createdAt > 0 && now - variant.createdAt > h.cfg.warmPoolTtlMs;
          const eligible =
            variant.runtime === PROFILE &&
            variant.identityMatches &&
            variant.digestMatches &&
            (variant.phase === "Running" || variant.phase === "Pending") &&
            !agedOut &&
            relay.registered &&
            relay.connected &&
            relay.attestation !== null;

          const outcome = await h.claim("sbx_gate");
          expect(outcome === "hit").toBe(eligible);
          if (eligible) {
            expect(h.claims).toHaveLength(1);
            expect(h.claims[0]!.poolId).toBe(pod.poolId);
          } else {
            expect(h.claims).toHaveLength(0);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("refuses a pod whose age is past the TTL", async () => {
    const h = harness();
    h.pods.push(
      warmPod(0, h.pool.identity(), h.profile.digest, {
        createdAt: h.clock.now - h.cfg.warmPoolTtlMs - 1,
      }),
    );
    expect(await h.claim("sbx_old")).toBe("miss_empty");
  });
});

describe("reconcile spends the budget, never the cap", () => {
  it("creates at most the missing pods, at most maxCreate, and never past target", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 0, max: 5 }),
        async (initialLive, target, maxCreate) => {
          const h = harness();
          const identity = h.pool.identity();
          for (let index = 0; index < initialLive; index += 1) {
            h.pods.push(warmPod(index, identity, h.profile.digest));
          }
          const budget = await h.pool.reconcile([...h.pods], {
            target,
            maxCreate,
            relayAddr: { host: "relay", port: 8443 },
            proxyAddr: { host: "proxy", port: 3128 },
          });
          expect(h.creates.length).toBeLessThanOrEqual(maxCreate);
          expect(budget).toBe(maxCreate - h.creates.length);
          // Every delete names a pod that existed, at most once.
          expect(new Set(h.deletes).size).toBe(h.deletes.length);
          expect(h.deletes.length).toBeLessThanOrEqual(initialLive);
          const liveAfter = h.pods.filter((pod) => pod.runtime === PROFILE).length;
          expect(liveAfter).toBeLessThanOrEqual(Math.max(initialLive, target));
          if (target === 0) expect(liveAfter).toBe(0);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("stops creating when admission refuses, whatever the target", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (target) => {
        const h = harness({ capacityAdmitted: false });
        const budget = await h.pool.reconcile([...h.pods], {
          target,
          maxCreate: 2,
          relayAddr: { host: "relay", port: 8443 },
          proxyAddr: { host: "proxy", port: 3128 },
        });
        // Nothing was created, so the pass returns its whole budget.
        expect(h.creates).toHaveLength(0);
        expect(budget).toBe(2);
      }),
      { numRuns: 20 },
    );
  });

  it("never deletes a claimed pod when the target drops to zero", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (idleCount) => {
        const h = harness();
        const identity = h.pool.identity();
        for (let index = 1; index <= idleCount; index += 1) {
          h.pods.push(warmPod(index, identity, h.profile.digest));
        }
        const claimed = warmPod(0, identity, h.profile.digest);
        h.pods.unshift(claimed);
        const inFlight = await h.claimInFlight("sbx_holding");
        await h.pool.reconcile([...h.pods], { target: 0, maxCreate: 0 });
        expect(h.deletes).not.toContain(claimed.name);
        inFlight.finish();
        expect(await inFlight.result).toBe("hit");
      }),
      { numRuns: 20 },
    );
  });
});

describe("a failed handoff is a miss, never a hit", () => {
  it("reports miss_error and releases the reserve for every failing step", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"register" | "claim" | "relabel" | "provisioning">(
          "register",
          "claim",
          "relabel",
          "provisioning",
        ),
        async (failAt) => {
          const h = harness({ failAt });
          const pod = warmPod(0, h.pool.identity(), h.profile.digest);
          h.pods.push(pod);
          const outcome = await h.claim("sbx_failed");
          expect(outcome).toBe("miss_error");
          expect(h.claims).toHaveLength(failAt === "relabel" || failAt === "provisioning" ? 1 : 0);
          if (failAt === "register") {
            // Registration never spent the pod; it can be retried next pass.
            expect(h.pods.map((candidate) => candidate.warmId)).toContain(pod.warmId);
            expect(h.deletes).toHaveLength(0);
          } else {
            // The pod was picked, so the handoff owns deleting it rather than
            // leaving a stranded claim in the pool.
            expect(h.deletes).toEqual([pod.name]);
          }
        },
      ),
      { numRuns: 8 },
    );
  });
});
