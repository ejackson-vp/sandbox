import type { BenchOptions } from "../lib/options.js";
import { Bench, createAndReady, timedDestroy, timedExec, type CreateAndReadyResult } from "../lib/runner.js";
import {
  dockerStats,
  sandboxPodCount,
  waitForNoSandboxPods,
  warmPodCount,
  WORKER,
} from "../lib/env.js";
import { fmtMs, mapLimit, summarize, type Summary } from "../lib/util.js";

const MEM_GUARD_BYTES = 6.8 * 1024 ** 3;

interface BurstAttempt {
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  session?: CreateAndReadyResult;
}

interface BurstLevel {
  level: number;
  poolBefore: number;
  created: number;
  ready: number;
  failed: number;
  errorCodes: string[];
  warmHits: number;
  coldFallbacks: number;
  createMs: Summary | null;
  readyMs: Summary | null;
  warmClaimMs: Summary | null;
  wallMs: number;
  throughputPerSecond: number;
  execOk: number;
  execMs: Summary | null;
  teardownMs: Summary | null;
  warmAfter: number;
  sandboxPodsAfter: number;
  dockerMemBytes: number;
  notes: string[];
}

function specOf(opts: BenchOptions, durationSeconds: number) {
  return {
    tier: "custom" as const,
    durationSeconds,
    cpuMillis: opts.cpuMillis,
    memoryMiB: opts.memoryMiB,
    diskMiB: opts.diskMiB,
  };
}

/**
 * Burst: fire N paid creates at the same time and measure what the pool and
 * admission control do. Unlike density, this deliberately does not pace the
 * creates; the point is the arrival-rate spike.
 */
export async function runBurst(bench: Bench, opts: BenchOptions): Promise<number> {
  const duration = opts.duration > 0 ? opts.duration : 60;
  const spec = specOf(opts, duration);
  const levels = opts.levels.filter((l) => l <= opts.max).sort((a, b) => a - b);
  if (levels.length === 0) {
    bench.note("no burst levels within --max");
    return 2;
  }

  bench.note(`burst: levels ${levels.join(",")}, spec ${JSON.stringify(spec)}`);
  const results: BurstLevel[] = [];

  for (const level of levels) {
    const notes: string[] = [];
    bench.note(`burst ${level}: cleaning up`);
    await bench.cleanupAll();
    await waitForNoSandboxPods(60_000);

    const poolBefore = warmPodCount();
    bench.note(`burst ${level}: pool before=${poolBefore}`);
    const started = performance.now();

    const attempts: BurstAttempt[] = await Promise.all(
      Array.from({ length: level }, async () => {
        try {
          return { ok: true, session: await createAndReady(bench, spec, 180_000) };
        } catch (err) {
          const e = err as { code?: string; message?: string };
          return { ok: false, errorCode: e.code ?? "create_failed", errorMessage: e.message };
        }
      }),
    );
    const wallMs = performance.now() - started;
    const ready = attempts.filter((a) => a.ok && a.session).map((a) => a.session!);
    const failed = attempts.filter((a) => !a.ok);
    const errorCodes = [...new Set(failed.map((a) => a.errorCode ?? "unknown"))];
    if (errorCodes.length > 0) notes.push(`create errors: ${JSON.stringify(errorCodes)}`);

    const warmHits = ready.filter((s) => s.timings?.warmPoolHit === 1).length;
    const coldFallbacks = ready.length - warmHits;
    if (coldFallbacks > 0) notes.push(`${coldFallbacks} cold fallback(s)`);

    const execs = await mapLimit(ready, Math.min(ready.length || 1, opts.concurrency), async (s) => {
      const r = await timedExec(bench, s.handle, ["bash", "-c", "echo burst"], { timeoutMs: 30_000 });
      return { ok: Boolean(r.result) && r.result?.exitCode === 0, ms: r.ms };
    });

    const teardowns = await mapLimit(ready, 10, async (s) => {
      try {
        return (await timedDestroy(bench, s.handle)).totalMs;
      } catch {
        return NaN;
      }
    });
    await waitForNoSandboxPods(90_000);
    const warmAfter = warmPodCount();
    const sandboxPodsAfter = sandboxPodCount();
    if (sandboxPodsAfter > 0) notes.push(`${sandboxPodsAfter} session pod(s) remained after teardown`);
    if (warmAfter < poolBefore) notes.push(`pool not replenished (${warmAfter}/${poolBefore})`);

    const docker = dockerStats().find((d) => d.name === WORKER);
    const row: BurstLevel = {
      level,
      poolBefore,
      created: attempts.length,
      ready: ready.length,
      failed: failed.length,
      errorCodes,
      warmHits,
      coldFallbacks,
      createMs: summarize(ready.map((s) => s.createMs)),
      readyMs: summarize(ready.map((s) => s.readyObservedMs)),
      warmClaimMs: summarize(
        ready.map((s) => s.derived?.warmClaimMs ?? NaN).filter((n) => Number.isFinite(n)),
      ),
      wallMs,
      throughputPerSecond: ready.length > 0 ? (ready.length / wallMs) * 1000 : 0,
      execOk: execs.filter((e) => e.ok).length,
      execMs: summarize(execs.map((e) => e.ms)),
      teardownMs: summarize(teardowns.filter((n) => Number.isFinite(n))),
      warmAfter,
      sandboxPodsAfter,
      dockerMemBytes: docker?.memBytes ?? 0,
      notes,
    };
    bench.append(row as never);
    results.push(row);
    bench.note(
      `burst ${level}: ready ${row.ready}/${row.created}, warm ${row.warmHits}, cold ${row.coldFallbacks}, ` +
        `p50 ${fmtMs(row.readyMs?.p50)} p95 ${fmtMs(row.readyMs?.p95)}, ${row.throughputPerSecond.toFixed(1)}/s, ` +
        `pool after ${row.warmAfter}${notes.length ? `; ${notes.join("; ")}` : ""}`,
    );

    if (row.dockerMemBytes > MEM_GUARD_BYTES) {
      bench.note(`memory guard: worker at ${(row.dockerMemBytes / 1024 ** 3).toFixed(1)}GiB; stopping escalation`);
      break;
    }
  }

  bench.writeJson("burst.summary.json", {
    spec,
    levels: results,
    measuredAt: new Date().toISOString(),
  });
  bench.writeCsv(
    "burst.csv",
    results.map((r) => ({
      level: r.level,
      poolBefore: r.poolBefore,
      created: r.created,
      ready: r.ready,
      failed: r.failed,
      errorCodes: r.errorCodes.join("|"),
      warmHits: r.warmHits,
      coldFallbacks: r.coldFallbacks,
      createP50: r.createMs?.p50?.toFixed(1) ?? "",
      readyP50: r.readyMs?.p50?.toFixed(0) ?? "",
      readyP95: r.readyMs?.p95?.toFixed(0) ?? "",
      readyP99: r.readyMs?.p99?.toFixed(0) ?? "",
      warmClaimP50: r.warmClaimMs?.p50?.toFixed(0) ?? "",
      wallMs: r.wallMs.toFixed(0),
      throughputPerSecond: r.throughputPerSecond.toFixed(2),
      execOk: r.execOk,
      teardownP50: r.teardownMs?.p50?.toFixed(0) ?? "",
      warmAfter: r.warmAfter,
      sandboxPodsAfter: r.sandboxPodsAfter,
      dockerMemMiB: (r.dockerMemBytes / 1024 ** 2).toFixed(0),
    })),
  );
  return 0;
}
