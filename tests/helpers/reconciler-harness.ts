/**
 * One fake durable store and one recording set of collaborators for the
 * reconciler's scheduler.
 *
 * The store reproduces the three SQL rules the tick depends on, because they are
 * what make the scheduler's promises observable without a database:
 *
 *   - `listDue` returns non-terminal rows whose `next_due_ms` has passed,
 *     earliest first and capped by the caller's limit;
 *   - `rearmDue` only applies while the row is *still* due, so a concurrent
 *     transition that armed a future deadline wins;
 *   - `listTerminalWithPod` stops returning a row as soon as `clearPod` nulls
 *     its pod reference, which is why a terminal pod is swept exactly once.
 *
 * The collaborators are replaced at their seams (`Provisioning`, `Lifecycle`,
 * `Termination`, `LeaseHealth`, and the housekeeping steps), not at `tick`, so
 * the real phase order, the real dispatcher and the real state switch run
 * around them.
 */
import { isTerminal, type SessionState } from "@x402s/shared/protocol";
import type { ControllerConfig } from "../../controller/src/config.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import { Reconciler } from "../../controller/src/reconciler.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import type { ReconcilerStore } from "../../controller/src/store/ports.js";
import { controllerConfig } from "./controller-config.js";
import { limitsFor, sessionFixture } from "./store-fixtures.js";

/** A due row is selected at `next_due_ms <= now`; seed it just in the past. */
export const NOW = 1_000_000;

export interface SessionSeed {
  state?: SessionState;
  /** `next_due_ms`. Defaults to just past `NOW`, so the first pass sees it. */
  dueAt?: number;
  podName?: string | null;
  destroyRequested?: boolean;
  leaseExpiresAt?: number | null;
}

export interface HarnessOptions {
  env?: NodeJS.ProcessEnv;
  sessions?: Record<string, SessionSeed>;
}

/** An observed collaborator call, in the order the reconciler made it. */
export interface Operation {
  op: string;
  id?: string;
}

export type Hook = (session: SessionRecord) => Promise<void> | void;

/** The private collaborators the scheduler delegates to, for stubbing. */
export interface Collaborators {
  provisioning: {
    provision(session: SessionRecord): Promise<void>;
    awaitReady(session: SessionRecord): Promise<void>;
  };
  lifecycle: {
    reconcileSuspend(session: SessionRecord): Promise<void>;
    enforce(): Promise<void>;
    cleanup(): Promise<void>;
    suspend(id: string): Promise<void>;
    resume(id: string): Promise<void>;
  };
  lease: { enforce(session: SessionRecord): Promise<void> };
  termination: {
    terminate(session: SessionRecord): Promise<void>;
    sweep(): Promise<void>;
    sweepPvcs(): Promise<void>;
    reconcileRefunds(): Promise<void>;
  };
  warm: { reconcile(): Promise<void> };
  fence: { reconcile(): Promise<void> };
  relayRecovery: { reconcile(): Promise<void> };
  settlementRecovery: { run(): Promise<void> };
  refundWorker: { run(): Promise<void> };
  ctx: { capacity: { reap(): Promise<void> } };
}

/** The reconciler's private fields, typed as the scheduler sees them. */
export function internals(reconciler: Reconciler): Collaborators {
  return reconciler as unknown as Collaborators;
}

type Failable =
  | "listDue"
  | "listTerminalWithPod"
  | "countLiveByState"
  | "countDue"
  | "rearmDue";

/**
 * The scheduler's view of the store. Every read records what the pass asked
 * for, so a test can assert the bound rather than infer it.
 */
export class TickStore {
  private readonly rows = new Map<string, SessionRecord>();
  private readonly due = new Map<string, number>();
  private readonly failures = new Map<Failable, number>();

  readonly dueReads: Array<{ now: number; limit: number }> = [];
  readonly rearmCalls: Array<{ id: string; at: number; now: number }> = [];
  readonly clearPodCalls: string[] = [];
  readonly terminations: Array<{ id: string; reason: string }> = [];

  countDueCalls = 0;
  countLiveCalls = 0;
  terminalReads = 0;
  /** A single ordered log, so a pass's steps can be compared to a model. */
  onCall: ((op: string) => void) | null = null;
  /** Model a concurrent writer that already moved the row to TERMINATING. */
  refuseTermination = false;
  /** Model the row being reaped between the request and the re-read. */
  dropAfterTermination = false;

  /** Fail the next `times` calls of one store method. */
  fail(method: Failable, times = 1): void {
    this.failures.set(method, (this.failures.get(method) ?? 0) + times);
  }

  private maybeFail(method: Failable): void {
    const remaining = this.failures.get(method) ?? 0;
    if (remaining <= 0) return;
    this.failures.set(method, remaining - 1);
    throw new Error(`${method} failed`);
  }

  seed(session: SessionRecord, dueAt: number): void {
    this.rows.set(session.id, session);
    this.due.set(session.id, dueAt);
  }

  row(id: string): SessionRecord | undefined {
    return this.rows.get(id);
  }

  /** Move a row behind the store's back, to model a concurrent writer. */
  forceState(id: string, state: SessionState): void {
    const row = this.rows.get(id);
    if (row) row.state = state;
  }

  remove(id: string): void {
    this.rows.delete(id);
    this.due.delete(id);
  }

  async listDue(now: number, limit: number): Promise<SessionRecord[]> {
    this.dueReads.push({ now, limit });
    this.maybeFail("listDue");
    return [...this.rows.values()]
      .filter((row) => !isTerminal(row.state) && (this.due.get(row.id) ?? 0) <= now)
      .sort((a, b) => (this.due.get(a.id)! - this.due.get(b.id)!) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async rearmDue(id: string, atMs: number, nowMs: number): Promise<boolean> {
    this.rearmCalls.push({ id, at: atMs, now: nowMs });
    this.maybeFail("rearmDue");
    // The guarded write: only a row that is still due is re-armed.
    if ((this.due.get(id) ?? 0) > nowMs) return false;
    this.due.set(id, atMs);
    return true;
  }

  async listTerminalWithPod(): Promise<SessionRecord[]> {
    this.terminalReads += 1;
    this.maybeFail("listTerminalWithPod");
    return [...this.rows.values()]
      .filter((row) => isTerminal(row.state) && row.podName !== null)
      .map((row) => ({ ...row }));
  }

  async countLiveByState(): Promise<Partial<Record<SessionState, number>>> {
    this.countLiveCalls += 1;
    this.maybeFail("countLiveByState");
    const counts: Partial<Record<SessionState, number>> = {};
    for (const row of this.rows.values()) {
      if (isTerminal(row.state)) continue;
      counts[row.state] = (counts[row.state] ?? 0) + 1;
    }
    return counts;
  }

  async countDue(now: number): Promise<number> {
    this.countDueCalls += 1;
    this.maybeFail("countDue");
    return [...this.rows.values()].filter(
      (row) => !isTerminal(row.state) && (this.due.get(row.id) ?? 0) <= now,
    ).length;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async requestTermination(
    id: string,
    reason: string,
    _failure?: { code: string; message: string },
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (this.refuseTermination) return false;
    if (!row || isTerminal(row.state) || row.state === "TERMINATING") return false;
    row.state = "TERMINATING";
    row.terminationReason = reason;
    this.terminations.push({ id, reason });
    if (this.dropAfterTermination) this.rows.delete(id);
    return true;
  }

  async clearPod(id: string): Promise<void> {
    this.clearPodCalls.push(id);
    const row = this.rows.get(id);
    if (row) row.podName = null;
  }

  /** Read by the clock-jump report the reconciler fires and forgets. */
  async listNonTerminal(): Promise<SessionRecord[]> {
    return [...this.rows.values()]
      .filter((row) => !isTerminal(row.state))
      .map((row) => ({ ...row }));
  }

  async pruneChallengeNonces(): Promise<number> {
    this.onCall?.("prune_nonces");
    return 0;
  }

  async countLedgerByStatus(): Promise<number> {
    this.onCall?.("refund_worker");
    return 0;
  }

  async listStaleClaimedIntents(): Promise<[]> {
    this.onCall?.("settlement_recovery");
    return [];
  }

  /** Only reached when housekeeping runs the real capacity reaper. */
  readonly reservations = {
    reapExpiredHolds: async () => 0,
    listActive: async () => [],
  };
}

function seedSession(id: string, seed: SessionSeed, clock: { now: number }): SessionRecord {
  return sessionFixture({
    id,
    paymentKey: `payment-${id}`,
    tier: "standard",
    durationSeconds: 300,
    limits: limitsFor("unit"),
    clientPublicKey: "pk".repeat(22),
    clientNonce: "nn".repeat(22),
    now: clock.now,
    overrides: {
      state: seed.state ?? "PAID",
      podName: seed.podName ?? null,
      destroyRequested: seed.destroyRequested ? 1 : 0,
      ...(seed.leaseExpiresAt !== undefined ? { leaseExpiresAt: seed.leaseExpiresAt } : {}),
    },
  });
}

export function harness(options: HarnessOptions = {}) {
  const cfg: ControllerConfig = controllerConfig(options.env);
  const clock = { now: NOW };
  const store = new TickStore();
  const ops: Operation[] = [];
  const hooks = new Map<string, Hook>();
  // One ordered log for collaborators and for the store calls that stand in for
  // a step, so the slow path can be compared against one fixed order.
  store.onCall = (op) => ops.push({ op });

  const deletes: string[] = [];
  const failedDeletes = new Set<string>();

  const provisioner = {
    deletePod: async (name: string) => {
      deletes.push(name);
      ops.push({ op: "delete_pod", id: name });
      if (failedDeletes.has(name)) throw new Error(`delete refused: ${name}`);
    },
    listWarmPods: async () => {
      ops.push({ op: "warm_list" });
      return [];
    },
  } as unknown as Provisioner;

  const reconciler = new Reconciler({
    cfg,
    store: store as unknown as ReconcilerStore,
    provisioner,
    relay: { isReady: async () => true } as unknown as RelayClient,
    now: () => clock.now,
  });

  const record = (op: string) =>
    async (session?: SessionRecord): Promise<void> => {
      ops.push(session ? { op, id: session.id } : { op });
      await hooks.get(op)?.(session as SessionRecord);
    };

  const c = internals(reconciler);
  Object.assign(c.provisioning, {
    provision: record("provision"),
    awaitReady: record("await_ready"),
  });
  Object.assign(c.lease, { enforce: record("lease_enforce") });
  Object.assign(c.lifecycle, {
    reconcileSuspend: record("reconcile_suspend"),
    suspend: async (id: string) => {
      ops.push({ op: "lifecycle_suspend", id });
      await hooks.get("lifecycle_suspend")?.({ id } as SessionRecord);
    },
    resume: async (id: string) => {
      ops.push({ op: "lifecycle_resume", id });
      await hooks.get("lifecycle_resume")?.({ id } as SessionRecord);
    },
    enforce: record("lifecycle_enforce"),
    cleanup: record("lifecycle_cleanup"),
  });
  Object.assign(c.termination, {
    terminate: record("terminate"),
    sweep: record("termination_sweep"),
    sweepPvcs: record("sweep_pvcs"),
    reconcileRefunds: record("refund_reconcile"),
  });
  Object.assign(c.fence, { reconcile: record("fence_reconcile") });
  Object.assign(c.relayRecovery, { reconcile: record("relay_recovery") });
  Object.assign(c.ctx.capacity, { reap: record("capacity_reap") });

  const add = (id: string, seed: SessionSeed = {}): SessionRecord => {
    const session = seedSession(id, seed, clock);
    store.seed(session, seed.dueAt ?? NOW - 1);
    return session;
  };

  for (const [id, seed] of Object.entries(options.sessions ?? {})) add(id, seed);

  return {
    cfg,
    clock,
    store,
    reconciler,
    internals: c,
    ops,
    deletes,
    add,
    /** Fail every delete of this pod name, to model an apiserver refusal. */
    refuseDelete: (name: string) => failedDeletes.add(name),
    /** Run inside a collaborator call, before it returns. */
    hook: (op: string, fn: Hook) => hooks.set(op, fn),
    /** The reconciler's fast path, with the clock pinned at `clock.now`. */
    pass: () => reconciler.tick(),
    /** The reconciler's slow path. */
    housekeeping: () =>
      (reconciler as unknown as { housekeeping(): Promise<void> }).housekeeping(),
  };
}
