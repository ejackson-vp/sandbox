#!/usr/bin/env node
/**
 * Reconcile ceiling benchmark: how many live sessions can one controller's
 * reconcile loop sustain inside its 250 ms tick?
 *
 *   npx tsx scripts/bench-reconcile-ceiling.ts
 *
 * Per session count: a fresh temporary SQLite database, a realistic state mix
 * (80% READY, 10% PROVISIONING, 5% SUSPENDED, 5% PAID) with plausible
 * timestamps, lease deadlines and due times, then the *real* `Reconciler.tick()`
 * driven against a fake Provisioner, a fake RelayClient and an injected clock.
 * No Kubernetes, no network, no pod create latency.
 *
 * It measures, per N and per budget: rows returned by `listDue`, rows actually
 * dispatched, truncated passes, `listDue` p50/p95, tick p50/p95 (does one pass
 * fit in RECONCILE_INTERVAL_MS), and where the pass time went. The second
 * series raises RECONCILE_BUDGET to 5000 so a budget cut-off is distinguishable
 * from raw SQL cost.
 *
 * NOT modelled: pod creation latency, Kubernetes API calls, relay round trips,
 * network, guest hello, checkpoint I/O, and tick skipping when a pass overruns
 * (the virtual clock advances one interval per pass either way). This is the
 * scheduler and store cost only, on a local SSD with the shipped
 * `PRAGMA synchronous = FULL`. A network volume is slower, so the ceiling is an upper bound.
 *
 * Knobs (all optional): BENCH_COUNTS=100,500 BENCH_PASSES=50 BENCH_WARMUP=15
 * BENCH_BUDGETS=1000,5000 BENCH_SEED=42 LOG_LEVEL=error
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { ControllerConfig } from "../controller/src/config.js";
import type { Provisioner } from "../controller/src/k8s.js";
import type { RelayClient } from "../controller/src/relay-client.js";
import type { Reconciler } from "../controller/src/reconciler.js";
import type { SessionRecord, SessionState, Store } from "../controller/src/store.js";
import type { RelaySessionState } from "../shared/src/index.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The reconciler imports the built workspace package (`@x402s/shared`), which
 * `npm ci` does not produce. Build it once rather than making the gate a
 * two-command incantation. Same prerequisite CI satisfies before running tests.
 */
function ensureSharedBuilt(): void {
  if (existsSync(join(REPO_ROOT, "shared/dist/index.js"))) return;
  console.log("bench: building @x402s/shared (one-off; the controller imports its dist)");
  execFileSync("npm", ["run", "build", "-w", "@x402s/shared"], { cwd: REPO_ROOT, stdio: "inherit" });
}

process.env.LOG_LEVEL ??= "error";
ensureSharedBuilt();

const { loadControllerConfig } = await import("../controller/src/config.js");
const { Reconciler: ReconcilerClass } = await import("../controller/src/reconciler.js");
const { Store: StoreClass } = await import("../controller/src/store.js");

/* ------------------------------------------------------------------ config */

const ADMIN = "bench-admin-token-0123456789";

function config(budget: number): ControllerConfig {
  return loadControllerConfig({
    ADMIN_TOKEN: ADMIN,
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    // Admission is a Kubernetes-node question. With nodes disabled the snapshot
    // builder reports one oversized synthetic node, so admission always admits
    // and its cost is the reservation write only.
    CAPACITY_ENABLED: "false",
    WARM_POOL_SIZE: "0",
    DB_PATH: ":memory:",
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
    RECONCILE_BUDGET: String(budget),
  });
}

/* ------------------------------------------------------------------- fakes */

/** Resolves immediately. Nothing here waits for Kubernetes. */
const fakeProvisioner = {
  createPod: async (spec: { sessionId: string }) => ({ podName: `pod-${spec.sessionId}` }),
  createWarmPod: async () => ({ podName: "pod-warm" }),
  createWorkspacePvc: async (sessionId: string) => `pvc-${sessionId}`,
  deleteWorkspacePvc: async () => undefined,
  suspendPod: async () => undefined,
  deletePod: async () => undefined,
  // A live guest: READY health probes see Running, PROVISIONING never trips the
  // terminal-pod path, and no Kubernetes call is made.
  getPod: async () => ({ phase: "Running", deleted: false }),
  nodeAvailable: async () => true,
  workspacePvcExists: async () => true,
  listWorkspacePvcs: async () => [],
  listSandboxPods: async () => [],
  listWarmPods: async () => [],
  patchPodLabels: async () => undefined,
  getServiceAddress: async () => ({ host: "127.0.0.1", port: 8443 }),
  listNodes: async () => [],
} as unknown as Provisioner;

/** Registered but not connected: a guest that has not dialled yet. */
const relayState = { registered: true, connected: false, pending: 0 } as unknown as RelaySessionState;

const fakeRelay = {
  isReady: async () => true,
  healthFor: async () => ({ ok: true, generation: "bench-1" }),
  health: async () => ({ ok: true, generation: "bench-1" }),
  state: async () => relayState,
  registerCurrent: async () => ({ generation: "bench-1", attempts: 1 }),
} as unknown as RelayClient;

/* ----------------------------------------------------------------- seeding */

/** Deterministic PRNG so a run is reproducible from BENCH_SEED. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cadence per state, mirroring controller/src/reconcile-cadence.ts. */
const CADENCE_MS: Record<string, number> = { PAID: 250, PROVISIONING: 250, READY: 1_000, SUSPENDED: 15_000 };

/**
 * State for index i: 16/20 READY, 2/20 PROVISIONING, 1/20 SUSPENDED, 1/20
 * PAID. Interleaved rather than blocked so state does not correlate with id
 * order or with the due-time order the index walks.
 */
function stateForIndex(i: number): SessionState {
  const slot = i % 20;
  if (slot < 16) return "READY";
  if (slot < 18) return "PROVISIONING";
  return slot === 18 ? "SUSPENDED" : "PAID";
}

const INSERT_PAYMENT = `INSERT INTO payments
  (payment_key, network, scheme, asset, amount, pay_to, payer, tx, mode, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SESSION_INSERT_COLUMNS = `id, capability_hash, capability_expires_at, client_public_key,
  client_nonce, tier, duration_seconds, cpu_millis, memory_mib, disk_mib, max_output_bytes,
  max_file_bytes, max_command_seconds, max_processes, state, created_at, paid_at, ready_at,
  lease_expires_at, payment_key, pod_name, runtime_class, execution_mode, relay_token_hash,
  idle_policy_json, max_lifetime_seconds, last_activity_at, suspended_at, baseline_cpu_millis,
  baseline_memory_mib, node_name, next_due_ms, updated_at`;

const INSERT_SESSION = `INSERT INTO sessions (${SESSION_INSERT_COLUMNS})
  VALUES (${new Array(33).fill("?").join(", ")})`;

const BENCH_SESSION_ID = (i: number): string => `sbx_bench_${String(i).padStart(6, "0")}`;

/**
 * Seed N sessions in one transaction on a second connection to the same file.
 *
 * Raw inserts, not `Store` calls: the point is to set `next_due_ms`, `ready_at`
 * and `lease_expires_at` to chosen values, and one transaction keeps seeding
 * (an fsync per autocommit otherwise) out of the measurement. Every column
 * written is one the real create path writes.
 */
function seed(path: string, count: number, nowMs: number, seedValue: number): void {
  const rng = mulberry32(seedValue);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  const insertPayment = db.prepare(INSERT_PAYMENT);
  const insertSession = db.prepare(INSERT_SESSION);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let i = 0; i < count; i += 1) {
      const id = BENCH_SESSION_ID(i);
      const paymentKey = `pay_bench_${String(i).padStart(6, "0")}`;
      const state = stateForIndex(i);
      const cadence = CADENCE_MS[state] ?? 250;
      // Spread arrivals across one cadence window: in steady state the due set
      // is then ~count * (interval / cadence), which is what bounds the read.
      const nextDue = nowMs + Math.floor(rng() * cadence);
      const paidAt = nowMs - Math.floor(rng() * 30_000);
      const isReady = state === "READY";
      const isSuspended = state === "SUSPENDED";
      // READY: up for a while, lease comfortably in the future, so the pass
      // exercises the health probe and the deadline comparison, not termination.
      const readyAt = isReady ? nowMs - 2_000 - Math.floor(rng() * 598_000) : null;
      const leaseExpiresAt = isReady ? nowMs + 60_000 + Math.floor(rng() * 3_540_000) : null;
      const suspendedAt = isSuspended ? nowMs - Math.floor(rng() * 600_000) : null;
      insertPayment.run(
        paymentKey, "mock:local", "exact", "mock:usdc", "50000",
        "0x0000000000000000000000000000000000000402",
        "0x0000000000000000000000000000000000000001", "mock:tx", "mock", paidAt,
      );
      insertSession.run(
        id, "a".repeat(64), nowMs + 3_600_000, "bench-client-public-key", "bench-client-nonce",
        "standard", 300, 1_000, 1_024, 1_024, 262_144, 8_388_608, 300, 256,
        state, paidAt - 1_000, paidAt, readyAt, leaseExpiresAt, paymentKey,
        isSuspended ? null : `pod-${id}`, "x402-sandbox", "dev",
        isSuspended ? null : "bench-relay-token-hash", isSuspended ? "{}" : null, 28_800,
        readyAt, suspendedAt, 250, 256, null, nextDue, paidAt,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.close();
  }
}

/* --------------------------------------------------------- instrumentation */

interface Instruments {
  listDueMs: number;
  listDueRows: number;
  countDueMs: number;
  countLiveMs: number;
  getSessionMs: number;
  rearmDueMs: number;
  dispatched: number;
}

function zeroInstruments(): Instruments {
  return {
    listDueMs: 0, listDueRows: 0, countDueMs: 0, countLiveMs: 0,
    getSessionMs: 0, rearmDueMs: 0, dispatched: 0,
  };
}

/**
 * Wrap the four store calls a pass makes plus the per-session dispatch, so the
 * pass can be split into due-read, per-session read, per-session write, gauges
 * and residual. Instance-level patching: no runtime module is modified.
 */
function instrument(store: Store, reconciler: Reconciler, m: Instruments): void {
  const listDue = store.listDue.bind(store);
  const countDue = store.countDue.bind(store);
  const countLive = store.countLiveByState.bind(store);
  const getSession = store.getSession.bind(store);
  const rearmDue = store.rearmDue.bind(store);

  store.listDue = (nowMs, limit) => {
    const started = performance.now();
    const rows = listDue(nowMs, limit);
    m.listDueMs += performance.now() - started;
    m.listDueRows += rows.length;
    return rows;
  };
  store.countDue = (nowMs) => {
    const started = performance.now();
    const n = countDue(nowMs);
    m.countDueMs += performance.now() - started;
    return n;
  };
  store.countLiveByState = () => {
    const started = performance.now();
    const counts = countLive();
    m.countLiveMs += performance.now() - started;
    return counts;
  };
  store.getSession = (id) => {
    const started = performance.now();
    const record = getSession(id);
    m.getSessionMs += performance.now() - started;
    return record;
  };
  store.rearmDue = (id, atMs, nowMs) => {
    const started = performance.now();
    const moved = rearmDue(id, atMs, nowMs);
    m.rearmDueMs += performance.now() - started;
    return moved;
  };

  const target = reconciler as unknown as {
    reconcileSession: (record: SessionRecord) => Promise<void>;
  };
  const reconcileSession = target.reconcileSession.bind(reconciler);
  target.reconcileSession = async (record) => {
    m.dispatched += 1;
    await reconcileSession(record);
  };
}

/* -------------------------------------------------------------- statistics */

function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(p * samples.length) - 1));
  return samples[index] ?? 0;
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

interface PassSample {
  tickMs: number;
  listDueMs: number;
  rows: number;
  dispatched: number;
  countDueMs: number;
  countLiveMs: number;
  getSessionMs: number;
  rearmDueMs: number;
  truncated: boolean;
}

interface SeriesResult {
  sessions: number;
  budget: number;
  intervalMs: number;
  passes: number;
  samples: PassSample[];
  totalMs: number;
}

/* --------------------------------------------------------------- the series */

interface RunOptions {
  sessions: number;
  budget: number;
  passes: number;
  warmup: number;
  seedValue: number;
  deadline: number;
}

async function runSeries(options: RunOptions): Promise<SeriesResult> {
  const { sessions, budget, passes, warmup, seedValue, deadline } = options;
  const cfg = config(budget);
  const dir = mkdtempSync(join(tmpdir(), "x402-ceiling-"));
  const path = join(dir, "controller.db");
  const store = new StoreClass(path);
  const wallStarted = performance.now();
  try {
    const created = Date.now();
    seed(path, sessions, created, seedValue);

    // Virtual clock: one RECONCILE_INTERVAL_MS per pass. Re-arm and the
    // lease/deadline comparisons all read this clock, never Date.now().
    const clock = { now: created };
    const reconciler = new ReconcilerClass({
      cfg,
      store,
      provisioner: fakeProvisioner,
      relay: fakeRelay,
      now: () => clock.now,
    });
    const m = zeroInstruments();
    instrument(store, reconciler, m);

    const samples: PassSample[] = [];
    let ran = 0;
    for (let pass = 0; pass < passes; pass += 1) {
      Object.assign(m, zeroInstruments());
      const started = performance.now();
      await reconciler.tick();
      const tickMs = performance.now() - started;
      if (pass >= warmup) {
        samples.push({
          tickMs,
          listDueMs: m.listDueMs,
          rows: m.listDueRows,
          dispatched: m.dispatched,
          countDueMs: m.countDueMs,
          countLiveMs: m.countLiveMs,
          getSessionMs: m.getSessionMs,
          rearmDueMs: m.rearmDueMs,
          // The pass truncates exactly when the due read filled the budget.
          truncated: m.listDueRows >= budget,
        });
      }
      ran += 1;
      clock.now += cfg.reconcileIntervalMs;
      if (performance.now() > deadline && pass >= warmup + 4) break;
    }
    return {
      sessions,
      budget,
      intervalMs: cfg.reconcileIntervalMs,
      passes: ran,
      samples,
      totalMs: performance.now() - wallStarted,
    };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Why the per-session path costs what it does: the same re-arm UPDATE in
 * autocommit with the shipped `synchronous = FULL` and with fsync disabled.
 * A diagnostic on a throwaway database, not part of the series above.
 */
function writeCostProbe(seedValue: number): Array<{ mode: string; usPerUpdate: number }> {
  const dir = mkdtempSync(join(tmpdir(), "x402-ceiling-probe-"));
  const path = join(dir, "probe.db");
  const store = new StoreClass(path);
  const count = 1_000;
  try {
    seed(path, count, Date.now(), seedValue);
    const db = new DatabaseSync(path);
    try {
      const update = db.prepare(
        "UPDATE sessions SET next_due_ms = ? WHERE id = ? AND (next_due_ms IS NULL OR next_due_ms <= ?)",
      );
      const reset = db.prepare("UPDATE sessions SET next_due_ms = NULL");
      const result: Array<{ mode: string; usPerUpdate: number }> = [];
      for (const mode of ["FULL", "NORMAL", "OFF"]) {
        db.exec(`PRAGMA synchronous = ${mode}`);
        reset.run();
        const started = performance.now();
        for (let i = 0; i < count; i += 1) {
          const at = Date.now() + 1_000;
          update.run(at, BENCH_SESSION_ID(i), Date.now());
        }
        result.push({ mode, usPerUpdate: ((performance.now() - started) * 1_000) / count });
      }
      return result;
    } finally {
      db.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------- reporting */

interface Summary {
  sessions: number;
  budget: number;
  passes: number;
  rowsMean: number;
  dispatchedMean: number;
  truncatedPct: number;
  listDueMean: number;
  listDueP50: number;
  listDueP95: number;
  tickMean: number;
  tickP50: number;
  tickP95: number;
  tickMax: number;
  sessionReadMs: number;
  sessionWriteMs: number;
  gaugesMs: number;
  residualMs: number;
}

function summarise(result: SeriesResult): Summary {
  const s = result.samples;
  const ticks = s.map((sample) => sample.tickMs).sort((a, b) => a - b);
  const due = s.map((sample) => sample.listDueMs).sort((a, b) => a - b);
  const listDueMean = mean(s.map((sample) => sample.listDueMs));
  const sessionReadMs = mean(s.map((sample) => sample.getSessionMs));
  const sessionWriteMs = mean(s.map((sample) => sample.rearmDueMs));
  const gaugesMs = mean(s.map((sample) => sample.countDueMs + sample.countLiveMs));
  const tickMean = mean(s.map((sample) => sample.tickMs));
  return {
    sessions: result.sessions,
    budget: result.budget,
    passes: s.length,
    rowsMean: mean(s.map((sample) => sample.rows)),
    dispatchedMean: mean(s.map((sample) => sample.dispatched)),
    truncatedPct: (s.filter((sample) => sample.truncated).length / Math.max(1, s.length)) * 100,
    listDueMean,
    listDueP50: percentile(due, 0.5),
    listDueP95: percentile(due, 0.95),
    tickMean,
    tickP50: percentile(ticks, 0.5),
    tickP95: percentile(ticks, 0.95),
    tickMax: ticks[ticks.length - 1] ?? 0,
    sessionReadMs,
    sessionWriteMs,
    gaugesMs,
    // Everything the instruments do not account for: dispatch bookkeeping, the
    // provisioning/lifecycle use cases, metrics and promise scheduling.
    residualMs: tickMean - listDueMean - gaugesMs - sessionReadMs - sessionWriteMs,
  };
}

function line(cells: string[], widths: number[]): string {
  return cells.map((cell, index) => cell.padStart(widths[index] ?? 0)).join("  ");
}

function printSeries(summaries: Summary[], intervalMs: number): void {
  const widths = [7, 9, 9, 6, 11, 11, 9, 9, 9, 7];
  console.log(line(["N", "rows/pass", "disp/pass", "trunc%", "listDue p50", "listDue p95", "tick p50", "tick p95", "tick max", ">250ms"], widths));
  for (const summary of summaries) {
    console.log(
      line(
        [
          String(summary.sessions),
          summary.rowsMean.toFixed(1),
          summary.dispatchedMean.toFixed(1),
          summary.truncatedPct.toFixed(0),
          summary.listDueP50.toFixed(2),
          summary.listDueP95.toFixed(2),
          summary.tickP50.toFixed(2),
          summary.tickP95.toFixed(2),
          summary.tickMax.toFixed(2),
          summary.tickP95 > intervalMs ? "yes" : "no",
        ],
        widths,
      ),
    );
  }
}

function printBreakdown(summaries: Summary[]): void {
  console.log("  mean ms per pass (one unit for the whole table: ms)");
  const widths = [7, 8, 10, 9, 7, 9, 10, 12];
  console.log(line(["N", "listDue", "getSession", "rearmDue", "gauges", "residual", "tick mean", "us/dispatch"], widths));
  for (const summary of summaries) {
    const perDispatch =
      summary.dispatchedMean > 0 ? (summary.tickMean * 1_000) / summary.dispatchedMean : 0;
    console.log(
      line(
        [
          String(summary.sessions),
          summary.listDueMean.toFixed(2),
          summary.sessionReadMs.toFixed(2),
          summary.sessionWriteMs.toFixed(2),
          summary.gaugesMs.toFixed(2),
          summary.residualMs.toFixed(2),
          summary.tickMean.toFixed(2),
          perDispatch.toFixed(0),
        ],
        widths,
      ),
    );
  }
}

/**
 * First N whose p95 tick exceeds the interval, plus a linear interpolation
 * between it and the N below it. Reported with the due rate at that point,
 * because that, not the session count, is what the loop actually pays for.
 */
function crossing(summaries: Summary[], intervalMs: number): string {
  const over = summaries.findIndex((summary) => summary.tickP95 > intervalMs);
  if (over < 0) {
    const last = summaries[summaries.length - 1];
    return `p95 stays below ${intervalMs} ms up to N=${last?.sessions} (${last?.tickP95.toFixed(1)} ms)`;
  }
  if (over === 0) return `p95 already exceeds ${intervalMs} ms at N=${summaries[0]?.sessions}`;
  const high = summaries[over]!;
  const low = summaries[over - 1]!;
  const span = high.tickP95 - low.tickP95;
  const ratio = span > 0 ? (intervalMs - low.tickP95) / span : 0;
  const sessions = Math.round(low.sessions + ratio * (high.sessions - low.sessions));
  const rows = low.rowsMean + ratio * (high.rowsMean - low.rowsMean);
  return (
    `p95 crosses ${intervalMs} ms between N=${low.sessions} (${low.tickP95.toFixed(1)} ms) and ` +
    `N=${high.sessions} (${high.tickP95.toFixed(1)} ms); interpolated ceiling ~N=${sessions} ` +
    `(~${rows.toFixed(0)} due rows/pass)`
  );
}

/**
 * The other ceiling: the budget is a hard cap on dispatches per pass, so at
 * some N the due read always fills it and cadence cannot be met however fast a
 * pass is. Derived from the measured due rate at the largest untruncated N.
 */
function sustainable(summaries: Summary[]): string {
  const untruncated = summaries.filter((summary) => summary.truncatedPct === 0);
  const basis = untruncated[untruncated.length - 1];
  if (!basis) return "budget: every pass truncated; due rate not measurable";
  const rate = basis.rowsMean / basis.sessions;
  const limit = Math.floor(basis.budget / rate);
  return (
    `budget: ${basis.budget} rows/pass sustains ~${limit} sessions at the measured ` +
    `${rate.toFixed(3)} due rows per session per pass`
  );
}

/* -------------------------------------------------------------------- main */
function numbersFromEnv(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw.split(",").map((part) => Number(part.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length ? parsed : fallback;
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const counts = numbersFromEnv("BENCH_COUNTS", [100, 500, 1_000, 2_500, 5_000, 10_000]);
  const budgets = numbersFromEnv("BENCH_BUDGETS", [1_000, 5_000]);
  const passes = numberFromEnv("BENCH_PASSES", 50);
  const warmup = numberFromEnv("BENCH_WARMUP", 15);
  const seedValue = numberFromEnv("BENCH_SEED", 42);
  // The whole run is meant to stay around two minutes; large N stops early if
  // it would overrun and reports how many samples it actually took.
  const deadline = performance.now() + numberFromEnv("BENCH_BUDGET_MS", 110_000);

  const intervalMs = config(1_000).reconcileIntervalMs;
  console.log(`reconcile ceiling benchmark: interval ${intervalMs} ms, ${passes} passes (${warmup} warmup), rng ${seedValue}`);
  console.log("fake provisioner/relay, injected clock, capacity admission disabled. Times are ms unless stated.\n");

  const byBudget = new Map<number, Summary[]>();
  for (const budget of budgets) {
    const summaries: Summary[] = [];
    for (const sessions of counts) {
      const result = await runSeries({ sessions, budget, passes, warmup, seedValue, deadline });
      const summary = summarise(result);
      summaries.push(summary);
      console.log(`run N=${sessions} budget=${budget}: ${summary.passes} samples in ${(result.totalMs / 1_000).toFixed(1)} s`);
    }
    byBudget.set(budget, summaries);
  }

  console.log("");
  for (const budget of budgets) {
    const summaries = byBudget.get(budget) ?? [];
    console.log(`RECONCILE_BUDGET=${budget}`);
    printSeries(summaries, intervalMs);
    console.log("");
    printBreakdown(summaries);
    console.log(`  ${crossing(summaries, intervalMs)}`);
    console.log(`  ${sustainable(summaries)}\n`);
  }

  const probe = writeCostProbe(seedValue);
  const full = probe.find((entry) => entry.mode === "FULL")?.usPerUpdate ?? 0;
  const fastest = Math.min(...probe.map((entry) => entry.usPerUpdate));
  console.log("write path probe: the same re-arm UPDATE, 1000 rows, autocommit");
  for (const entry of probe) {
    console.log(`  synchronous=${entry.mode.padEnd(6)} ${entry.usPerUpdate.toFixed(1).padStart(6)} us/update`);
  }
  console.log(`  fsync accounts for ~${(100 * (1 - fastest / Math.max(full, 1))).toFixed(0)}% of the per-session write\n`);

  console.log("not modelled: pod create latency, Kubernetes API calls, relay round trips, network,");
  console.log("guest hello, checkpoint I/O, and tick skipping when a pass overruns.");
}

await main();
