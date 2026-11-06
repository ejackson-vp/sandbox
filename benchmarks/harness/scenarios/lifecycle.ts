import type { BenchOptions } from "../lib/options.js";
import { Bench, createAndReady, timedDestroy, timedExec } from "../lib/runner.js";
import { fmtMs, summarize, type Summary } from "../lib/util.js";

interface LifecycleRow {
  sizeMiB: number;
  ok: boolean;
  errorCode?: string;
  readyMs?: number;
  writeMs?: number;
  suspendMs?: number;
  resumeMs?: number;
  verifyMs?: number;
  verifyOk?: boolean;
}

interface SizeSummary {
  sizeMiB: number;
  samples: number;
  ok: number;
  readyMs: Summary | null;
  writeMs: Summary | null;
  suspendMs: Summary | null;
  resumeMs: Summary | null;
  verifyMs: Summary | null;
}

function specOf(opts: BenchOptions, sizeMiB: number) {
  return {
    tier: "custom" as const,
    durationSeconds: 60,
    cpuMillis: opts.cpuMillis,
    memoryMiB: opts.memoryMiB,
    diskMiB: Math.max(opts.diskMiB, sizeMiB + 128),
    idlePolicy: { maxIdleSeconds: 300, suspendedDurationSeconds: 600, autoResume: false },
  };
}

/**
 * Checkpoint benchmark: write a workspace of a given size, suspend, resume, and
 * verify it. The PVC is not copied on suspend/resume, so this tests whether the
 * data size affects recovery at all.
 */
export async function runLifecycle(bench: Bench, opts: BenchOptions): Promise<number> {
  const sizes = (opts.levels.length > 0 ? opts.levels : [0, 32, 256]).sort((a, b) => a - b);
  const samples = opts.samples > 0 ? opts.samples : 3;
  const rows: LifecycleRow[] = [];

  bench.note(`lifecycle: sizes ${sizes.join(",")} MiB, ${samples} sample(s) each`);

  for (const sizeMiB of sizes) {
    for (let i = 0; i < samples; i++) {
      const row: LifecycleRow = { sizeMiB, ok: false };
      try {
        const session = await createAndReady(bench, specOf(opts, sizeMiB), 180_000);
        row.readyMs = session.readyObservedMs;

        const write = await timedExec(
          bench,
          session.handle,
          [
            "bash",
            "-c",
            sizeMiB > 0
              ? `dd if=/dev/zero of=blob.bin bs=1M count=${sizeMiB} status=none && wc -c < blob.bin`
              : "printf checkpoint > blob.bin && wc -c < blob.bin",
          ],
          { timeoutMs: Math.max(60_000, sizeMiB * 1_000) },
        );
        row.writeMs = write.ms;

        const beforeSuspend = performance.now();
        await bench.client.suspend(session.handle);
        row.suspendMs = performance.now() - beforeSuspend;

        const beforeResume = performance.now();
        await bench.client.resume(session.handle, 180_000);
        row.resumeMs = performance.now() - beforeResume;

        const verify = await timedExec(bench, session.handle, ["bash", "-c", "wc -c < blob.bin"], {
          timeoutMs: 30_000,
        });
        row.verifyMs = verify.ms;
        const expected = sizeMiB > 0 ? sizeMiB * 1024 * 1024 : "checkpoint".length;
        row.verifyOk = Boolean(verify.result && verify.result.exitCode === 0 && verify.result.stdout.trim() === String(expected));

        const destroyed = await timedDestroy(bench, session.handle);
        row.ok = Boolean(write.result) && row.verifyOk === true && destroyed.state === "DESTROYED";
      } catch (err) {
        const e = err as { code?: string };
        row.errorCode = e.code ?? "exception";
      }
      rows.push(row);
      bench.append(row as never);
      bench.note(
        `${sizeMiB}MiB ${i + 1}/${samples}: ${row.ok ? "ok" : row.errorCode} ` +
          `ready ${fmtMs(row.readyMs)} suspend ${fmtMs(row.suspendMs)} resume ${fmtMs(row.resumeMs)} ` +
          `write ${fmtMs(row.writeMs)} verify ${row.verifyOk ? "ok" : "FAIL"}`,
      );
    }
  }

  const summaries: SizeSummary[] = sizes.map((sizeMiB) => {
    const group = rows.filter((r) => r.sizeMiB === sizeMiB && r.ok);
    return {
      sizeMiB,
      samples: rows.filter((r) => r.sizeMiB === sizeMiB).length,
      ok: group.length,
      readyMs: summarize(group.map((r) => r.readyMs ?? NaN).filter(Number.isFinite)),
      writeMs: summarize(group.map((r) => r.writeMs ?? NaN).filter(Number.isFinite)),
      suspendMs: summarize(group.map((r) => r.suspendMs ?? NaN).filter(Number.isFinite)),
      resumeMs: summarize(group.map((r) => r.resumeMs ?? NaN).filter(Number.isFinite)),
      verifyMs: summarize(group.map((r) => r.verifyMs ?? NaN).filter(Number.isFinite)),
    };
  });

  bench.writeJson("lifecycle.summary.json", {
    sizes,
    samples,
    summaries,
    measuredAt: new Date().toISOString(),
  });
  bench.writeCsv(
    "lifecycle.csv",
    rows.map((r) => ({
      sizeMiB: r.sizeMiB,
      ok: r.ok,
      errorCode: r.errorCode ?? "",
      readyMs: r.readyMs?.toFixed(0) ?? "",
      writeMs: r.writeMs?.toFixed(0) ?? "",
      suspendMs: r.suspendMs?.toFixed(0) ?? "",
      resumeMs: r.resumeMs?.toFixed(0) ?? "",
      verifyMs: r.verifyMs?.toFixed(0) ?? "",
      verifyOk: r.verifyOk ?? "",
    })),
  );
  return rows.every((r) => r.ok) ? 0 : 1;
}
