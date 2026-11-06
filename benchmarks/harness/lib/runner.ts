/**
 * Session runner: wraps the real SDK with monotonic timing, server-side
 * timings, resource sampling and result export.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SandboxClient, FileSessionStore, type SessionHandle } from "../../../sdk/src/index.js";
import type { ExecResult, SessionStatus, SessionTimings } from "../../../shared/src/index.js";
import {
  API_URL,
  captureHost,
  componentUsage,
  nodeUsage,
  parseSandboxUsage,
  relayMetrics,
  controllerMetrics,
  apiMetrics,
  sandboxUsageCommand,
  sweepSandboxes,
  waitForNoSandboxPods,
  type HostInfo,
} from "./env.js";
import { nowIso, sleep, toCsv } from "./util.js";

export interface DerivedTimings {
  apiMs?: number;
  entitlementMs?: number;
  tickToProvisionMs?: number;
  podCreateCallMs?: number;
  podRequestedToRunningMs?: number;
  runningToHelloMs?: number;
  helloToReadyMs?: number;
  serverReadyMs?: number;
  serverProvisionMs?: number;
  readyToClientObservedMs?: number;
  cleanupMs?: number;
}

export interface SampleRow {
  scenario: string;
  iteration: number;
  level?: number;
  mode?: string;
  tier?: string;
  durationSeconds?: number;
  startedAt: string;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  createMs?: number;
  readyObservedMs?: number;
  firstExecMs?: number;
  sessionId?: string;
  destroyMs?: number;
  podGoneMs?: number;
  totalMs?: number;
  server?: SessionTimings;
  derived?: DerivedTimings;
  usage?: Record<string, number>;
  workload?: Record<string, unknown>;
  stages?: Record<string, number | undefined>;
  notes?: string;
}

export class Bench {
  readonly runId: string;
  readonly runDir: string;
  readonly host: HostInfo;
  readonly client: SandboxClient;
  private readonly storeDir: string;
  private readonly notes: string[] = [];

  constructor(readonly scenarioName: string, runId?: string) {
    this.host = captureHost();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.runId = runId ?? `${stamp}-${this.host.gitCommit}`;
    this.runDir = join(process.cwd(), "benchmarks", "results", this.runId);
    mkdirSync(this.runDir, { recursive: true });
    this.storeDir = mkdtempSync(join(tmpdir(), "x402-bench-store-"));
    this.client = new SandboxClient({
      apiUrl: API_URL,
      paymentMode: "mock",
      allowInsecureDev: true,
      store: new FileSessionStore(this.storeDir),
      log: () => {},
    });
    this.writeJson("environment.json", {
      capturedAt: nowIso(),
      runId: this.runId,
      scenario: scenarioName,
      host: this.host,
      env: {
        API_URL,
        KUBECTL_CONTEXT: process.env.KUBECTL_CONTEXT,
        BENCH_MAX_CONCURRENCY: process.env.BENCH_MAX_CONCURRENCY,
      },
    });
  }

  note(text: string): void {
    this.notes.push(`${nowIso()} ${text}`);
    console.error(`[bench] ${text}`);
  }

  writeJson(name: string, value: unknown): void {
    writeFileSync(join(this.runDir, name), JSON.stringify(value, null, 2));
  }

  readJson<T>(name: string): T | null {
    try {
      return JSON.parse(readFileSync(join(this.runDir, name), "utf8")) as T;
    } catch {
      return null;
    }
  }

  append(sample: SampleRow): void {
    appendFileSync(join(this.runDir, `${this.scenarioName}.jsonl`), JSON.stringify(sample) + "\n");
  }

  finish(extra: Record<string, unknown> = {}): void {
    this.writeJson(`${this.scenarioName}.meta.json`, {
      runId: this.runId,
      scenario: this.scenarioName,
      finishedAt: nowIso(),
      notes: this.notes,
      ...extra,
    });
  }

  rows(): SampleRow[] {
    try {
      const text = readFileSync(join(this.runDir, `${this.scenarioName}.jsonl`), "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SampleRow);
    } catch {
      return [];
    }
  }

  writeCsv(name: string, rows: Array<Record<string, unknown>>): void {
    writeFileSync(join(this.runDir, name), toCsv(rows));
  }

  /** Shared-infrastructure snapshot (operator-side cgroup reads). */
  infraSnapshot(): Record<string, unknown> {
    return {
      at: nowIso(),
      node: nodeUsage(),
      components: {
        api: componentUsage("api"),
        controller: componentUsage("controller"),
        relay: componentUsage("relay"),
        "egress-proxy": componentUsage("egress-proxy"),
        facilitator: componentUsage("facilitator"),
      },
      metrics: { api: apiMetrics(), controller: controllerMetrics(), relay: relayMetrics() },
    };
  }

  /** Per-sandbox cgroup usage (one command per sandbox). */
  async usage(handle: SessionHandle): Promise<Record<string, number> | null> {
    const res = await this.client.exec(handle, { command: sandboxUsageCommand(), timeoutMs: 15_000 });
    if (!res.ok || res.exitCode !== 0) return null;
    const u = parseSandboxUsage(res.stdout);
    return {
      memCurrentBytes: u.memCurrent,
      memAnonBytes: u.memAnon,
      memFileBytes: u.memFile,
      memPeakBytes: u.memPeak,
      cpuUsec: u.cpuUsec,
      throttledUsec: u.throttledUsec,
      nrThrottled: u.nrThrottled,
      pids: u.pids,
    };
  }

  async cleanupAll(timeoutMs = 60_000): Promise<{ swept: number; drained: boolean }> {
    const swept = sweepSandboxes();
    const drained = await waitForNoSandboxPods(timeoutMs);
    return { swept, drained };
  }
}

export function derive(
  server: SessionTimings | undefined,
  observed: { createMs: number; readyObservedMs?: number },
): DerivedTimings {
  if (!server) return {};
  const d: DerivedTimings = {
    apiMs: observed.createMs,
    entitlementMs: server.entitlementMs,
    podCreateCallMs: server.podCreateCallMs,
    cleanupMs: server.cleanupMs,
  };
  if (server.provisionStartAt && server.apiReceivedAt) {
    d.tickToProvisionMs = server.provisionStartAt - server.apiReceivedAt;
  }
  if (server.podRunningObservedAt && server.podRequestedAt) {
    d.podRequestedToRunningMs = server.podRunningObservedAt - server.podRequestedAt;
  }
  if (server.guestHelloAt && server.podRunningObservedAt) {
    d.runningToHelloMs = server.guestHelloAt - server.podRunningObservedAt;
  }
  if (server.readyAt && server.guestHelloAt) {
    d.helloToReadyMs = server.readyAt - server.guestHelloAt;
  }
  if (server.readyAt && server.apiReceivedAt) {
    d.serverReadyMs = server.readyAt - server.apiReceivedAt;
  }
  if (server.readyAt && server.provisionStartAt) {
    d.serverProvisionMs = server.readyAt - server.provisionStartAt;
  }
  if (observed.readyObservedMs !== undefined && server.readyAt && server.apiReceivedAt) {
    d.readyToClientObservedMs = observed.readyObservedMs - (server.readyAt - server.apiReceivedAt);
  }
  return d;
}

export interface CreateSessionOptions {
  tier?: "short" | "standard" | "extended" | "long" | "custom";
  durationSeconds?: number;
  cpuMillis?: number;
  memoryMiB?: number;
  diskMiB?: number;
}

export interface CreateAndReadyResult {
  handle: SessionHandle;
  status: SessionStatus;
  /** performance.now() immediately before the create request. */
  t0: number;
  /** Date.now() immediately before the create request (clock bridge). */
  epochAtT0: number;
  createMs: number;
  readyObservedMs: number;
  timings?: SessionTimings;
  derived: DerivedTimings;
  sessionId: string;
}

/** Create a session and wait for READY, capturing timings. */
export async function createAndReady(
  bench: Bench,
  opts: CreateSessionOptions,
  readyTimeoutMs = 180_000,
): Promise<CreateAndReadyResult> {
  const t0 = performance.now();
  const epochAtT0 = Date.now();
  const handle = await bench.client.createSession(opts);
  const createMs = performance.now() - t0;
  await bench.client.waitForReady(handle, readyTimeoutMs);
  const readyObservedMs = performance.now() - t0;
  const status = handle.status!;
  const timings = status.timings;
  return {
    handle,
    status,
    t0,
    epochAtT0,
    createMs,
    readyObservedMs,
    timings,
    derived: derive(timings, { createMs, readyObservedMs }),
    sessionId: handle.sessionId,
  };
}

export async function timedExec(
  bench: Bench,
  handle: SessionHandle,
  command: string[],
  extra: { timeoutMs?: number; env?: Record<string, string>; cwd?: string; stdin?: string } = {},
): Promise<{ result: ExecResult | null; ms: number; errorCode?: string; errorMessage?: string }> {
  const t0 = performance.now();
  try {
    const result = await bench.client.exec(handle, { command, ...extra });
    const ms = performance.now() - t0;
    if (!result.ok) {
      return { result: null, ms, errorCode: result.error?.code, errorMessage: result.error?.message };
    }
    return { result, ms };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { result: null, ms: performance.now() - t0, errorCode: e.code ?? "exception", errorMessage: e.message };
  }
}

export async function timedDestroy(
  bench: Bench,
  handle: SessionHandle,
): Promise<{ state: string; totalMs: number; cleanupMs?: number }> {
  const t0 = performance.now();
  const status = await bench.client.destroy(handle, 120_000);
  const totalMs = performance.now() - t0;
  const final = status ?? (await bench.client.status(handle).catch(() => null));
  return { state: final?.state ?? "DESTROYED", totalMs, cleanupMs: final?.timings?.cleanupMs };
}

/** Poll a session status until a predicate, returning observed latency. */
export async function pollUntil(
  bench: Bench,
  handle: SessionHandle,
  predicate: (s: SessionStatus) => boolean,
  timeoutMs = 120_000,
  intervalMs = 100,
): Promise<{ status: SessionStatus; ms: number } | null> {
  const t0 = performance.now();
  const deadline = t0 + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const status = await bench.client.status(handle);
      if (predicate(status)) return { status, ms: performance.now() - t0 };
    } catch {
      /* transient during restarts */
    }
    await sleep(intervalMs);
  }
  return null;
}
