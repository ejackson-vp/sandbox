import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchOptions } from "../lib/options.js";
import { WORKLOADS_DIR } from "../lib/options.js";
import { Bench, createAndReady, timedDestroy, timedExec } from "../lib/runner.js";
import {
  allocatedRequests,
  dockerStats,
  nodeUsage,
  sandboxPodCount,
  waitForNoSandboxPods,
  WORKER,
} from "../lib/env.js";
import { fmtBytes, fmtMs, mapLimit, sleep, summarize, type Summary } from "../lib/util.js";

const MEM_GUARD_BYTES = 6.8 * 1024 ** 3; // of the 7.75 GiB Docker VM

interface SessionResult {
  sessionId: string;
  ready: boolean;
  errorCode?: string;
  createMs: number;
  readyMs?: number;
  anonBytes?: number;
  fileBytes?: number;
  cpuUsec?: number;
  pids?: number;
}

interface LevelResult {
  level: number;
  mode: string;
  requested: { cpuMillis: number; memoryMiB: number; perSandboxMemoryBytes: number };
  created: number;
  ready: number;
  failed: number;
  pending: number;
  createMs: Summary | null;
  readyMs: Summary | null;
  anonBytes: Summary | null;
  fileBytes: Summary | null;
  pids: Summary | null;
  nodeMemBytes: number;
  workerDockerMemBytes: number;
  nodeCpuPct: number;
  infra: Record<string, unknown>;
  phase?: Record<string, unknown>;
  teardownMs: Summary | null;
  idleCpuCores: Summary | null;
  podsAfter: number;
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
 * The API's default create limiter is a 30-request burst with a 1/s refill.
 * The bucket is shared across levels in one run, so track cumulative creates and
 * throttle after the burst. This keeps density measurements about capacity
 * instead of admission control; the limiter's own cost is reported separately.
 */
let cumulativeCreates = 0;

async function createPaced(bench: Bench, spec: ReturnType<typeof specOf>, count: number): Promise<Array<{ handle?: any; error?: string; createMs: number }>> {
  const out: Array<{ handle?: any; error?: string; createMs: number }> = [];
  const burst = 25;
  let i = 0;
  while (i < count) {
    const size = Math.min(cumulativeCreates < burst ? 5 : 1, count - i);
    const results = await mapLimit(Array.from({ length: size }, (_, k) => i + k), size, async () => {
      const t0 = performance.now();
      try {
        const handle = await bench.client.createSession(spec);
        return { handle, createMs: performance.now() - t0 };
      } catch (err) {
        return { error: (err as { code?: string }).code ?? "create_failed", createMs: performance.now() - t0 };
      }
    });
    out.push(...results);
    i += size;
    cumulativeCreates += size;
    if (i < count) await sleep(cumulativeCreates <= burst ? 150 : 1000);
  }
  return out;
}

async function uploadWorkloads(bench: Bench, handles: any[]): Promise<void> {
  const hello = readFileSync(join(process.cwd(), WORKLOADS_DIR, "hello.py"));
  const compute = readFileSync(join(process.cwd(), WORKLOADS_DIR, "compute.py"));
  await mapLimit(handles, 10, async (h) => {
    await bench.client.putFile(h, { path: "/workspace/bench/hello.py", data: hello }).catch(() => null);
    await bench.client.putFile(h, { path: "/workspace/bench/compute.py", data: compute }).catch(() => null);
  });
}

/**
 * Density: create N sessions, sample idle/active behaviour, tear down.
 * Levels run sequentially; sessions within a level are created in small paced
 * batches to stay below the API's create rate limit (which is itself measured).
 */
export async function runDensity(bench: Bench, opts: BenchOptions): Promise<number> {
  const duration = opts.duration > 0 ? opts.duration : 240;
  const spec = specOf(opts, duration);
  const levels = opts.levels.filter((l) => l <= opts.max).sort((a, b) => a - b);
  if (levels.length === 0) {
    bench.note("no levels within --max");
    return 2;
  }
  const alloc = allocatedRequests();
  bench.note(
    `worker allocatable: ${(alloc.allocatableMemoryBytes / 1024 ** 2).toFixed(0)}MiB / ${(alloc.allocatableCpuMillis / 1000).toFixed(1)} cores / ${alloc.allocatablePods} pods; ` +
      `already requested ${(alloc.memoryBytes / 1024 ** 2).toFixed(0)}MiB / ${(alloc.cpuMillis / 1000).toFixed(2)} cores`,
  );
  bench.note(`per-sandbox request: ${Math.max(50, Math.floor(spec.cpuMillis / 4))}m CPU, ${Math.max(64, Math.floor(spec.memoryMiB / 4))}MiB memory`);

  const results: LevelResult[] = [];

  for (const level of levels) {
    const notes: string[] = [];
    bench.note(`level ${level} (${opts.mode}): cleaning up`);
    await bench.cleanupAll();
    await waitForNoSandboxPods(60_000);

    nodeUsage();
    const dockerBefore = dockerStats().find((d) => d.name === WORKER);
    const infraBefore = bench.infraSnapshot();
    const createResults = await createPaced(bench, spec, level);
    const handles = createResults.filter((r) => r.handle).map((r) => r.handle);
    const createErrors = createResults.filter((r) => r.error).map((r) => r.error!);
    if (createErrors.length > 0) {
      notes.push(`create error codes: ${JSON.stringify([...new Set(createErrors)])}`);
    }

    // Wait for readiness in parallel (SDK tolerates 429s).
    const readyFlags = await Promise.all(
      handles.map(async (h) => {
        try {
          await bench.client.waitForReady(h, 240_000);
          return true;
        } catch {
          return false;
        }
      }),
    );
    const readyHandles = handles.filter((_, i) => readyFlags[i]);
    const pending = level - handles.length;
    if (pending > 0) notes.push(`${pending} session(s) were not created (rate limit or API error)`);
    if (handles.length - readyHandles.length > 0) {
      notes.push(`${handles.length - readyHandles.length} session(s) did not become ready`);
    }

    // Settle, then measure node CPU over a quiet window before sampling cgroups.
    await sleep(3000);
    const quietStart = nodeUsage();
    const quietStartAt = Date.now();
    await sleep(3000);
    const nodeAfter = nodeUsage();
    const quietCpuPct = ((nodeAfter.cpuUsec - quietStart.cpuUsec) / ((Date.now() - quietStartAt) * 1000)) * 100;
    const usages = await mapLimit(readyHandles, 10, async (h) => {
      const u = await bench.usage(h);
      return u ?? {};
    });
    // Idle CPU: delta of each sandbox's cumulative cpu.stat over a quiet window.
    let idleCpuCores: number[] = [];
    if (opts.mode === "idle" && readyHandles.length > 0) {
      await sleep(3000);
      const afterUsage = await mapLimit(readyHandles, 10, async (h) => (await bench.usage(h)) ?? {});
      idleCpuCores = afterUsage.map((u, i) => ((u.cpuUsec ?? 0) - (usages[i]?.cpuUsec ?? 0)) / 3_000_000);
    }
    const dockerAfter = dockerStats().find((d) => d.name === WORKER);
    const infraAfter = bench.infraSnapshot();

    const anon = usages.map((u) => u.memAnonBytes ?? NaN).filter((n) => Number.isFinite(n));
    const files = usages.map((u) => u.memFileBytes ?? NaN).filter((n) => Number.isFinite(n));
    const pids = usages.map((u) => u.pids ?? NaN).filter((n) => Number.isFinite(n));

    let phase: Record<string, unknown> | undefined;
    if (opts.mode !== "idle" && readyHandles.length > 0) {
      await uploadWorkloads(bench, readyHandles);
      const phaseStart = performance.now();
      const ops = await mapLimit(readyHandles, Math.min(readyHandles.length, 25), async (h, i) => {
        const kind = opts.mode === "cpu" ? "compute" : ["compute", "exec", "exec", "fs", "https"][i % 5]!;
        if (kind === "compute") {
          const r = await timedExec(bench, h, ["python3", "/workspace/bench/compute.py"], { timeoutMs: 120_000 });
          return { kind, ok: Boolean(r.result), ms: r.ms, exit: r.result?.exitCode, code: r.errorCode };
        }
        if (kind === "exec") {
          const r = await timedExec(bench, h, ["python3", "/workspace/bench/hello.py"], { timeoutMs: 60_000 });
          return { kind, ok: Boolean(r.result), ms: r.ms, exit: r.result?.exitCode, code: r.errorCode };
        }
        if (kind === "fs") {
          const r = await timedExec(
            bench,
            h,
            ["bash", "-c", "dd if=/dev/zero of=/workspace/f.bin bs=64k count=16 status=none && sha256sum /workspace/f.bin | cut -c1-16"],
            { timeoutMs: 60_000 },
          );
          return { kind, ok: Boolean(r.result), ms: r.ms, exit: r.result?.exitCode, code: r.errorCode };
        }
        const r = await timedExec(
          bench,
          h,
          ["python3", "-c", "import urllib.request; print(urllib.request.urlopen('https://example.com', timeout=8).status)"],
          { timeoutMs: 20_000 },
        );
        return { kind, ok: Boolean(r.result) && r.result?.exitCode === 0, ms: r.ms, exit: r.result?.exitCode, code: r.errorCode };
      });
      const wall = performance.now() - phaseStart;
      const byKind = Object.fromEntries(
        [...new Set(ops.map((o) => o.kind))].map((k) => {
          const group = ops.filter((o) => o.kind === k);
          return [
            k,
            {
              count: group.length,
              ok: group.filter((o) => o.ok).length,
              latency: summarize(group.map((o) => o.ms)),
            },
          ];
        }),
      );
      phase = {
        wallMs: wall,
        opsPerSecond: (ops.length / wall) * 1000,
        byKind,
        errors: ops.filter((o) => !o.ok).map((o) => o.code ?? `exit_${o.exit}`),
      };
    }

    // Teardown.
    const teardownStart = performance.now();
    const teardowns = await mapLimit(readyHandles, 10, async (h) => {
      try {
        const d = await timedDestroy(bench, h);
        return d.totalMs;
      } catch {
        return NaN;
      }
    });
    const teardownMs = performance.now() - teardownStart;
    await waitForNoSandboxPods(90_000);
    const podsAfter = sandboxPodCount();
    if (podsAfter > 0) notes.push(`${podsAfter} pod(s) remained after teardown`);

    const row: LevelResult = {
      level,
      mode: opts.mode,
      requested: {
        cpuMillis: spec.cpuMillis,
        memoryMiB: spec.memoryMiB,
        perSandboxMemoryBytes: Math.max(64, Math.floor(spec.memoryMiB / 4)) * 1024 ** 2,
      },
      created: handles.length,
      ready: readyHandles.length,
      failed: createErrors.length + (handles.length - readyHandles.length),
      pending,
      createMs: summarize(createResults.map((r) => r.createMs)),
      readyMs: summarize(
        await Promise.all(
          readyHandles.map(async (h) => {
            const st = h.status;
            return st?.timings?.readyAt && st?.timings?.apiReceivedAt
              ? st.timings.readyAt - st.timings.apiReceivedAt
              : NaN;
          }),
        ),
      ),
      anonBytes: summarize(anon),
      fileBytes: summarize(files),
      pids: summarize(pids),
      nodeMemBytes: nodeAfter.memBytes,
      workerDockerMemBytes: dockerAfter?.memBytes ?? 0,
      nodeCpuPct: quietCpuPct,
      infra: {
        before: infraBefore,
        after: infraAfter,
        dockerBefore: dockerBefore ?? null,
        dockerAfter: dockerAfter ?? null,
      },
      phase,
      teardownMs: summarize(teardowns.filter((n) => Number.isFinite(n))),
      idleCpuCores: summarize(idleCpuCores),
      podsAfter,
      notes,
    };
    bench.append(row as never);
    results.push(row);
    bench.note(
      `level ${level}: ready ${readyHandles.length}/${level}, anon/sandbox ${fmtBytes(row.anonBytes?.p50 ?? 0)}, ` +
        `node ${fmtBytes(row.nodeMemBytes)}, teardown ${fmtMs(row.teardownMs?.p50)}${notes.length ? `; ${notes.join("; ")}` : ""}`,
    );
    if (opts.mode !== "idle") {
      const phases = row.phase as { opsPerSecond?: number; errors?: string[] } | undefined;
      bench.note(`  ops/s ${phases?.opsPerSecond?.toFixed(1)}, errors ${phases?.errors?.length ?? 0}`);
    }

    // Memory guard: stop escalating if the VM is close to its limit.
    if (row.workerDockerMemBytes > MEM_GUARD_BYTES) {
      bench.note(
        `memory guard: worker at ${fmtBytes(row.workerDockerMemBytes)} > ${fmtBytes(MEM_GUARD_BYTES)}; stopping escalation`,
      );
      break;
    }
  }

  bench.writeJson("density.summary.json", {
    mode: opts.mode,
    spec,
    allocatable: alloc,
    levels: results,
    measuredAt: new Date().toISOString(),
  });
  bench.writeCsv(
    "density.csv",
    results.map((r) => ({
      level: r.level,
      mode: r.mode,
      created: r.created,
      ready: r.ready,
      failed: r.failed,
      anonP50MiB: ((r.anonBytes?.p50 ?? 0) / 1024 ** 2).toFixed(2),
      anonP95MiB: ((r.anonBytes?.p95 ?? 0) / 1024 ** 2).toFixed(2),
      fileP50MiB: ((r.fileBytes?.p50 ?? 0) / 1024 ** 2).toFixed(2),
      pidsP50: r.pids?.p50 ?? "",
      nodeMemMiB: (r.nodeMemBytes / 1024 ** 2).toFixed(0),
      dockerMemMiB: (r.workerDockerMemBytes / 1024 ** 2).toFixed(0),
      createP50: r.createMs?.p50?.toFixed(1) ?? "",
      readyP50: r.readyMs?.p50?.toFixed(0) ?? "",
      teardownP50: r.teardownMs?.p50?.toFixed(0) ?? "",
      idleCpuCoresP50: r.idleCpuCores?.p50?.toFixed(4) ?? "",
      opsPerSecond: (r.phase as { opsPerSecond?: number } | undefined)?.opsPerSecond?.toFixed(1) ?? "",
      podsAfter: r.podsAfter,
    })),
  );

  if (!opts.json) {
    process.stdout.write(`\ndensity (${opts.mode})\n`);
    for (const r of results) {
      process.stdout.write(
        `n=${String(r.level).padEnd(4)} ready ${String(r.ready).padEnd(4)} ` +
          `anon/sbx ${fmtBytes(r.anonBytes?.p50 ?? 0).padEnd(10)} node ${fmtBytes(r.nodeMemBytes).padEnd(10)} ` +
          `ready p50 ${fmtMs(r.readyMs?.p50).padEnd(9)} teardown p50 ${fmtMs(r.teardownMs?.p50)}` +
          (r.idleCpuCores ? ` idle ${(r.idleCpuCores.p50 ?? 0).toFixed(4)} cores/sandbox` : "") + `\n`,
      );
    }
  }
  return results.every((r) => r.ready === r.level && r.podsAfter === 0) ? 0 : 1;
}

