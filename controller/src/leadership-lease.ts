/**
 * Kubernetes Lease leader election (coordination.k8s.io/v1).
 *
 * One writer, still. The Lease decides which replica is allowed to reconcile;
 * every other replica is a warm standby that holds no role and writes nothing.
 * That is failover, not horizontal scaling.
 *
 * Safety rules this file exists to enforce:
 *
 * - Renew before the deadline; step down at the deadline even when the API
 *   server is unreachable, because another replica may take over then.
 * - Only two writes are possible: renew the lease we hold, or take over a lease
 *   whose renewal we have watched stall for a full lease duration. Both are
 *   compare-and-swap on `metadata.resourceVersion`, so two replicas racing for
 *   the same lease cannot both win.
 * - Expiry is measured on our own clock from the moment we observed the record.
 *   Cross-node clock skew therefore delays a takeover, never overlaps two
 *   writers.
 * - A released lease (empty holder) is free immediately: the old holder
 *   released it only after it stopped scheduling work.
 */
import * as k8s from "@kubernetes/client-node";
import { log } from "@x402s/shared";
import type { ControllerConfig } from "./config.js";
import { BaseLeadership } from "./leadership.js";

/** Renewal cadence. Comfortably below the duration, so one failed call is tolerated. */
export const LEASE_RENEW_INTERVAL_MS = 2_000;
/** How long a holder may go unrenewed before another replica may force-acquire. */
export const LEASE_DURATION_MS = 10_000;
/**
 * One API call must not outlive a renewal window. Without a ceiling a hung
 * request would keep the loop from noticing that its own lease expired.
 */
const LEASE_CALL_TIMEOUT_MS = 1_500;

/**
 * A Lease as this module reads and writes it.
 *
 * Times are strings, not `Date`, because Kubernetes MicroTime only accepts
 * exactly six fractional digits and the generated client passes whatever it is
 * given straight through (`Date.toISOString()` produces three, which the API
 * server rejects with 400).
 */
export interface LeaseRecord {
  holderIdentity: string;
  leaseDurationSeconds: number;
  /** RFC3339 with microseconds. */
  acquireTime: string;
  /** RFC3339 with microseconds. */
  renewTime: string;
  leaseTransitions: number;
}

/** Format an epoch millisecond value the way MicroTime demands. */
export function microTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}

export interface LeaseSnapshot {
  record: LeaseRecord;
  resourceVersion: string;
}

/** The three verbs election needs, separated from the Kubernetes client for tests. */
export interface LeaseClient {
  read(name: string, namespace: string): Promise<LeaseSnapshot | null>;
  create(name: string, namespace: string, record: LeaseRecord): Promise<LeaseSnapshot>;
  replace(
    name: string,
    namespace: string,
    record: LeaseRecord,
    resourceVersion: string,
  ): Promise<LeaseSnapshot>;
}

export class KubeLeaseClient implements LeaseClient {
  private readonly coordination: k8s.CoordinationV1Api;

  constructor(kubeconfig?: k8s.KubeConfig) {
    const kc = kubeconfig ?? new k8s.KubeConfig();
    if (!kubeconfig) kc.loadFromDefault();
    this.coordination = kc.makeApiClient(k8s.CoordinationV1Api);
  }

  async read(name: string, namespace: string): Promise<LeaseSnapshot | null> {
    try {
      return toSnapshot(await this.coordination.readNamespacedLease({ name, namespace }));
    } catch (err) {
      if (statusCode(err) === 404) return null;
      throw err;
    }
  }

  async create(name: string, namespace: string, record: LeaseRecord): Promise<LeaseSnapshot> {
    const body: k8s.V1Lease = {
      apiVersion: "coordination.k8s.io/v1",
      kind: "Lease",
      metadata: { name, namespace },
      spec: toSpec(record),
    };
    return toSnapshot(await this.coordination.createNamespacedLease({ namespace, body }));
  }

  async replace(
    name: string,
    namespace: string,
    record: LeaseRecord,
    resourceVersion: string,
  ): Promise<LeaseSnapshot> {
    // The resourceVersion is the fence: the API server rejects a write built on
    // a record another replica has already replaced.
    const body: k8s.V1Lease = {
      apiVersion: "coordination.k8s.io/v1",
      kind: "Lease",
      metadata: { name, namespace, resourceVersion },
      spec: toSpec(record),
    };
    return toSnapshot(await this.coordination.replaceNamespacedLease({ name, namespace, body }));
  }
}

export interface LeaseLeadershipOptions {
  client: LeaseClient;
  namespace: string;
  name: string;
  identity: string;
  renewIntervalMs?: number;
  leaseDurationMs?: number;
  /** Wall clock, for the timestamps written into the Lease. */
  now?: () => number;
  /**
   * Monotonic clock, for the durations that decide when to step down and when a
   * foreign lease counts as stalled. A wall clock that jumps (NTP, suspend) must
   * not be able to shorten either window.
   */
  monotonic?: () => number;
  callTimeoutMs?: number;
}

export class LeaseLeadership extends BaseLeadership {
  readonly mode = "lease" as const;
  readonly identity: string;
  private readonly client: LeaseClient;
  private readonly namespace: string;
  private readonly name: string;
  private readonly renewIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly callTimeoutMs: number;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  /**
   * Our own deadline, from the moment a write of ours succeeded. Passed it, we
   * stop treating ourselves as the writer even if the API server never answers.
   */
  private expiresAt = 0;
  /** The foreign record we are waiting out, and when we first saw it unchanged. */
  private foreign: {
    holder: string;
    key: string;
    since: number;
    durationMs: number;
  } | null = null;

  constructor(options: LeaseLeadershipOptions) {
    super();
    this.client = options.client;
    this.namespace = options.namespace;
    this.name = options.name;
    this.identity = options.identity;
    this.renewIntervalMs = options.renewIntervalMs ?? LEASE_RENEW_INTERVAL_MS;
    this.leaseDurationMs = options.leaseDurationMs ?? LEASE_DURATION_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? LEASE_CALL_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.monotonic = options.monotonic ?? (() => performance.now());
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    log.info("leader_lease_watching", { lease: this.leaseRef(), identity: this.identity });
    await this.tick();
    this.schedule();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const wasLeader = this.leader;
    // Stop scheduling and refuse writes before the lease is released: another
    // replica may own it microseconds later.
    this.expiresAt = 0;
    this.setLeader(false);
    if (!wasLeader) return;
    await this.release();
  }

  /** One acquisition or renewal attempt. Public so tests can drive it directly. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.attempt();
    } catch (err) {
      log.warn("leader_lease_error", {
        lease: this.leaseRef(),
        identity: this.identity,
        error: (err as Error).message,
      });
    } finally {
      this.running = false;
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule());
    }, this.renewIntervalMs);
    // A pending renewal must not be the reason the process stays alive.
    this.timer.unref?.();
  }

  private async attempt(): Promise<void> {
    // stop() may have won the race against an in-flight attempt.
    if (this.stopped) return;
    const now = this.now();
    const mono = this.monotonic();
    if (this.leader && mono >= this.expiresAt) {
      // We could not renew in time (API outage, stalled event loop). Another
      // replica is entitled to the lease now, so give the writer role up first.
      log.warn("leader_lease_expired", { lease: this.leaseRef(), identity: this.identity });
      this.setLeader(false);
    }

    const snapshot = await this.call(
      () => this.client.read(this.name, this.namespace),
      "read",
    );
    if (!snapshot) {
      await this.create(now);
      return;
    }

    const { record, resourceVersion } = snapshot;
    if (record.holderIdentity === this.identity) {
      await this.renew(record, resourceVersion);
      return;
    }

    if (this.leader) {
      // The record names another holder. That only happens after a takeover (or
      // our own release), so the lease is gone whatever our clock says.
      this.loseLease("superseded");
    }
    this.observe(record, resourceVersion, mono);
    if (!this.foreignExpired(mono)) return;
    await this.takeOver(record, resourceVersion, now);
  }

  private async create(now: number): Promise<void> {
    try {
      const snapshot = await this.call(
        () =>
          this.client.create(this.name, this.namespace, {
            holderIdentity: this.identity,
            leaseDurationSeconds: this.durationSeconds,
            acquireTime: microTime(now),
            renewTime: microTime(now),
            leaseTransitions: 0,
          }),
        "create",
      );
      this.becomeLeader(snapshot.record);
    } catch (err) {
      if (!isConflict(err)) throw err;
      // Another replica created the lease between our read and our create.
      this.foreign = null;
    }
  }

  private async renew(record: LeaseRecord, resourceVersion: string): Promise<void> {
    try {
      const snapshot = await this.call(
        () =>
          this.client.replace(
            this.name,
            this.namespace,
            { ...record, leaseDurationSeconds: this.durationSeconds, renewTime: microTime(this.now()) },
            resourceVersion,
          ),
        "renew",
      );
      this.becomeLeader(snapshot.record);
    } catch (err) {
      if (!isConflict(err) && statusCode(err) !== 404) throw err;
      // Someone else holds it now, or it was deleted. Stop writing immediately
      // rather than at our own deadline.
      this.loseLease("renew_rejected");
    }
  }

  /** Drop the writer role now: the lease is no longer ours to renew. */
  private loseLease(reason: string): void {
    log.warn("leader_lease_lost", {
      lease: this.leaseRef(),
      identity: this.identity,
      reason,
    });
    this.expiresAt = 0;
    this.foreign = null;
    this.setLeader(false);
  }

  private observe(record: LeaseRecord, resourceVersion: string, mono: number): void {
    const key = `${record.holderIdentity}@${resourceVersion}`;
    if (this.foreign?.key === key) return;
    this.foreign = {
      holder: record.holderIdentity,
      key,
      since: mono,
      durationMs: Math.max(
        (record.leaseDurationSeconds || 0) * 1000,
        this.renewIntervalMs,
      ),
    };
  }

  private foreignExpired(now: number): boolean {
    if (!this.foreign) return false;
    // A released lease carries no holder. The release was an explicit write by
    // a holder that already stopped scheduling, so it is free right now.
    if (this.foreign.holder === "") return true;
    return now - this.foreign.since >= this.foreign.durationMs;
  }

  private async takeOver(record: LeaseRecord, resourceVersion: string, now: number): Promise<void> {
    try {
      const snapshot = await this.call(
        () =>
          this.client.replace(
            this.name,
            this.namespace,
            {
              holderIdentity: this.identity,
              leaseDurationSeconds: this.durationSeconds,
              acquireTime: microTime(now),
              renewTime: microTime(now),
              leaseTransitions: record.leaseTransitions + 1,
            },
            resourceVersion,
          ),
        "takeover",
      );
      log.info("leader_lease_takeover", {
        lease: this.leaseRef(),
        identity: this.identity,
        previousHolder: record.holderIdentity,
        transitions: snapshot.record.leaseTransitions,
      });
      this.becomeLeader(snapshot.record);
    } catch (err) {
      if (!isConflict(err)) throw err;
      // A third replica won, or the holder renewed after all. Re-observe.
      this.foreign = null;
    }
  }

  private becomeLeader(record: LeaseRecord): void {
    // stop() may have won the race against an in-flight attempt: the lease is
    // not ours to use any more.
    if (this.stopped) return;
    // Our deadline comes from our own monotonic clock at the moment our write
    // succeeded, never from the recorded renewTime: clocks differ between nodes.
    this.expiresAt = this.monotonic() + this.leaseDurationMs;
    this.foreign = null;
    if (this.leader) return;
    log.info("leader_lease_acquired", {
      lease: this.leaseRef(),
      identity: this.identity,
      transitions: record.leaseTransitions,
      durationMs: this.leaseDurationMs,
    });
    this.setLeader(true);
  }

  /** Best-effort graceful handover, so a rollout does not wait a full duration. */
  private async release(): Promise<void> {
    try {
      const snapshot = await this.call(
        () => this.client.read(this.name, this.namespace),
        "read",
      );
      if (!snapshot || snapshot.record.holderIdentity !== this.identity) return;
      await this.call(
        () =>
          this.client.replace(
            this.name,
            this.namespace,
            {
              ...snapshot.record,
              holderIdentity: "",
              leaseDurationSeconds: this.durationSeconds,
              renewTime: microTime(this.now()),
            },
            snapshot.resourceVersion,
          ),
        "release",
      );
      log.info("leader_lease_released", { lease: this.leaseRef(), identity: this.identity });
    } catch (err) {
      // A failed release only costs the next holder one lease duration.
      log.warn("leader_lease_release_failed", {
        lease: this.leaseRef(),
        identity: this.identity,
        error: (err as Error).message,
      });
    }
  }

  private get durationSeconds(): number {
    return Math.max(1, Math.round(this.leaseDurationMs / 1000));
  }

  private leaseRef(): string {
    return `${this.namespace}/${this.name}`;
  }

  private async call<T>(work: () => Promise<T>, what: string): Promise<T> {
    return withDeadline(work(), this.callTimeoutMs, `lease ${what}`);
  }
}

/** Lease-based leadership for a cluster; the identity is the pod name. */
export function makeLeaseLeadership(cfg: ControllerConfig): LeaseLeadership {
  return new LeaseLeadership({
    client: new KubeLeaseClient(),
    namespace: cfg.controlNamespace,
    name: cfg.leaderLeaseName,
    identity: cfg.leaderIdentity,
  });
}

function toSpec(record: LeaseRecord): k8s.V1LeaseSpec {
  return {
    holderIdentity: record.holderIdentity,
    leaseDurationSeconds: record.leaseDurationSeconds,
    // Strings: the generated model types these as Date, but MicroTime needs six
    // fractional digits and the serializer forwards the value untouched.
    acquireTime: record.acquireTime as unknown as k8s.V1MicroTime,
    renewTime: record.renewTime as unknown as k8s.V1MicroTime,
    leaseTransitions: record.leaseTransitions,
  };
}

function toSnapshot(lease: k8s.V1Lease): LeaseSnapshot {
  const spec = lease.spec ?? {};
  return {
    resourceVersion: lease.metadata?.resourceVersion ?? "",
    record: {
      holderIdentity: spec.holderIdentity ?? "",
      leaseDurationSeconds: spec.leaseDurationSeconds ?? 0,
      acquireTime: String(spec.acquireTime ?? ""),
      renewTime: String(spec.renewTime ?? ""),
      leaseTransitions: spec.leaseTransitions ?? 0,
    },
  };
}

function statusCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown })?.code;
  // Node network errors also carry a string `code` (ECONNREFUSED).
  return typeof code === "number" ? code : undefined;
}

function isConflict(err: unknown): boolean {
  return statusCode(err) === 409;
}

/** Reject after `ms` so a hung API call cannot stall the renewal loop. */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
