import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchOptions } from "../lib/options.js";
import { WORKLOADS_DIR } from "../lib/options.js";
import { Bench, createAndReady, pollUntil, timedDestroy, timedExec, type SampleRow } from "../lib/runner.js";
import { waitForPodGone } from "../lib/env.js";
import { makeTar } from "../../../tests/helpers/tar.js";
import { fmtBytes, fmtMs, mapLimit, summarize, type Summary } from "../lib/util.js";

function spec(opts: BenchOptions, durationSeconds: number) {
  return {
    tier: "custom" as const,
    durationSeconds,
    cpuMillis: opts.cpuMillis,
    memoryMiB: opts.memoryMiB,
    diskMiB: opts.diskMiB,
  };
}

function print(name: string, dist: Summary | null, extra = ""): void {
  if (!dist) {
    process.stdout.write(`${name.padEnd(28)} n/a\n`);
    return;
  }
  process.stdout.write(
    `${name.padEnd(28)} n=${String(dist.count).padEnd(4)} p50 ${fmtMs(dist.p50).padEnd(9)} p95 ${fmtMs(dist.p95).padEnd(9)} max ${fmtMs(dist.max).padEnd(9)}${extra}\n`,
  );
}

export async function runWorkloads(bench: Bench, opts: BenchOptions): Promise<number> {
  const out: Record<string, unknown> = {};
  const session = await createAndReady(bench, spec(opts, 600));
  bench.note(`workload session ${session.sessionId} ready in ${fmtMs(session.readyObservedMs)}`);
  const hello = readFileSync(join(process.cwd(), WORKLOADS_DIR, "hello.py"));
  const compute = readFileSync(join(process.cwd(), WORKLOADS_DIR, "compute.py"));
  await bench.client.putFile(session.handle, { path: "/workspace/bench/hello.py", data: hello });
  await bench.client.putFile(session.handle, { path: "/workspace/bench/compute.py", data: compute });

  // W1: hello world (minimum platform overhead).
  const w1: number[] = [];
  let w1Failures = 0;
  for (let i = 0; i < 20; i++) {
    const r = await timedExec(bench, session.handle, ["python3", "/workspace/bench/hello.py"]);
    if (r.result && r.result.stdout.includes("hello from the sandbox")) w1.push(r.ms);
    else w1Failures++;
  }
  out.w1_hello = { latency: summarize(w1), failures: w1Failures, n: 20 };

  // W2: deterministic Python CPU work, sequential baseline.
  const w2: number[] = [];
  for (let i = 0; i < 8; i++) {
    const r = await timedExec(bench, session.handle, ["python3", "/workspace/bench/compute.py"], { timeoutMs: 120_000 });
    if (r.result && r.result.exitCode === 0) w2.push(r.ms);
  }
  out.w2_compute_baseline = { latency: summarize(w2), n: 8 };

  // W2b: same workload in 5 concurrent sessions (contention).
  const concurrent = await mapLimit(Array.from({ length: 5 }, (_, i) => i), 5, async () => {
    const s = await createAndReady(bench, spec(opts, 300));
    await bench.client.putFile(s.handle, { path: "/workspace/bench/compute.py", data: compute });
    const r = await timedExec(bench, s.handle, ["python3", "/workspace/bench/compute.py"], { timeoutMs: 180_000 });
    await timedDestroy(bench, s.handle);
    return r.result ? r.ms : NaN;
  });
  out.w2_compute_concurrent5 = { latency: summarize(concurrent.filter((n) => Number.isFinite(n))), n: 5 };

  // W3: filesystem transfer round trip.
  const files = Array.from({ length: 20 }, (_, i) => ({
    name: `f${String(i).padStart(2, "0")}.txt`,
    content: `record ${i} ${"x".repeat(4096)}\n`,
  }));
  const archive = makeTar(files);
  const tarBytes = archive.length;
  const uploadStart = performance.now();
  const put = await bench.client.putFile(session.handle, {
    path: "/workspace/dataset",
    data: archive,
    archive: true,
  });
  const uploadMs = performance.now() - uploadStart;
  const modify = await timedExec(bench, session.handle, [
    "bash",
    "-c",
    "for f in /workspace/dataset/*.txt; do echo modified >> \"$f\"; done; ls /workspace/dataset | wc -l",
  ]);
  const downloadStart = performance.now();
  const got = await bench.client.getFile(session.handle, "/workspace/dataset", true);
  const downloadMs = performance.now() - downloadStart;
  const downloaded = got.ok ? Buffer.from(got.dataBase64, "base64") : Buffer.alloc(0);
  out.w3_filesystem = {
    archiveBytes: tarBytes,
    uploadedFiles: put.ok ? put.filesWritten : 0,
    uploadMs,
    uploadMiBs: (tarBytes / 1024 ** 2) / (uploadMs / 1000),
    modifyMs: modify.ms,
    downloadMs,
    downloadedBytes: downloaded.length,
    downloadMiBs: (downloaded.length / 1024 ** 2) / (downloadMs / 1000),
    ok: Boolean(put.ok && modify.result && got.ok),
  };

  // W4: dependency installation through the egress proxy (venv, no root).
  const pipSamples: number[] = [];
  let pipError: string | undefined;
  for (let i = 0; i < 3; i++) {
    const r = await timedExec(
      bench,
      session.handle,
      [
        "bash",
        "-c",
        `python3 -m venv /workspace/venv${i} && /workspace/venv${i}/bin/pip install --disable-pip-version-check --no-input --proxy "$HTTPS_PROXY" six 2>&1 | tail -2 && /workspace/venv${i}/bin/python -c 'import six; print("imported", six.__version__)'`,
      ],
      { timeoutMs: 180_000 },
    );
    if (r.result && r.result.exitCode === 0) pipSamples.push(r.ms);
    else pipError = r.errorCode ?? `exit ${r.result?.exitCode}`;
  }
  out.w4_pip_install = { latency: summarize(pipSamples), n: pipSamples.length, error: pipError };

  // W5: 20 commands in one session vs 10 fresh sessions (provisioning cost).
  const reuse: number[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await timedExec(bench, session.handle, ["bash", "-c", "echo hello"]);
    if (r.result) reuse.push(r.ms);
  }
  const fresh = await mapLimit(Array.from({ length: 10 }, (_, i) => i), 5, async () => {
    const s = await createAndReady(bench, spec(opts, 120));
    const r = await timedExec(bench, s.handle, ["bash", "-c", "echo hello"]);
    await timedDestroy(bench, s.handle);
    return { ready: s.readyObservedMs, exec: r.ms, total: s.readyObservedMs + r.ms };
  });
  out.w5_multi_command = {
    reuseExec: summarize(reuse),
    freshExec: summarize(fresh.map((f) => f.exec)),
    freshReady: summarize(fresh.map((f) => f.ready)),
    freshTotal: summarize(fresh.map((f) => f.total)),
    amortized20: reuse.reduce((a, b) => a + b, 0) / Math.max(1, reuse.length),
  };

  // W6: session expiration during a long command.
  const short = await createAndReady(bench, spec(opts, 4));
  const leaseEndsAt = short.status.leaseExpiresAt ? Date.parse(short.status.leaseExpiresAt) : Date.now() + 4000;
  const running = timedExec(bench, short.handle, ["bash", "-c", "echo start; sleep 60"], { timeoutMs: 120_000 });
  const gone = await waitForPodGone(short.sessionId, 120_000);
  const finished = await running;
  const terminationLatency = gone !== null ? Date.now() - leaseEndsAt : null;
  const late = await pollUntil(bench, short.handle, (s) => s.state === "EXPIRED" || s.state === "DESTROYED", 30_000, 100);
  out.w6_expiry = {
    leaseEndsAt,
    podGoneAfterLeaseMs: terminationLatency,
    commandCancelled: finished.result ? finished.result.cancelled || finished.result.timedOut : false,
    finalState: late?.status.state ?? "unknown",
    sessionUsableAfter: false,
    cleanupMs: late?.status.timings?.cleanupMs,
  };

  const destroyed = await timedDestroy(bench, session.handle);
  out.sessionDestroyMs = destroyed.totalMs;
  bench.writeJson("workloads.summary.json", out);

  const row: SampleRow = {
    scenario: "workloads",
    iteration: 0,
    startedAt: new Date().toISOString(),
    ok: Boolean(out.w3_filesystem && (out.w6_expiry as { finalState: string }).finalState !== "unknown"),
  };
  bench.append(row);
  bench.writeCsv("workloads.csv", Object.entries(out).map(([name, value]) => ({ workload: name, value: JSON.stringify(value) })));

  if (!opts.json) {
    process.stdout.write("\nworkloads\n");
    print("W1 hello (warm session)", (out.w1_hello as { latency: Summary | null }).latency, ` failures=${(out.w1_hello as { failures: number }).failures}`);
    print("W2 compute (1 session)", (out.w2_compute_baseline as { latency: Summary | null }).latency);
    print("W2 compute (5 concurrent)", (out.w2_compute_concurrent5 as { latency: Summary | null }).latency);
    const w3 = out.w3_filesystem as { uploadMs: number; uploadMiBs: number; downloadMs: number; downloadMiBs: number; downloadedBytes: number };
    process.stdout.write(
      `W3 filesystem                 upload ${fmtMs(w3.uploadMs)} (${w3.uploadMiBs.toFixed(2)} MiB/s), ` +
        `download ${fmtMs(w3.downloadMs)} (${w3.downloadMiBs.toFixed(2)} MiB/s, ${fmtBytes(w3.downloadedBytes)})\n`,
    );
    print("W4 pip install", (out.w4_pip_install as { latency: Summary | null }).latency, ` error=${(out.w4_pip_install as { error?: string }).error ?? "none"}`);
    print("W5 reuse exec", (out.w5_multi_command as { reuseExec: Summary | null }).reuseExec);
    print("W5 fresh ready+exec", (out.w5_multi_command as { freshTotal: Summary | null }).freshTotal);
    const w6 = out.w6_expiry as { podGoneAfterLeaseMs: number | null; finalState: string; commandCancelled: boolean };
    process.stdout.write(
      `W6 expiry                     pod gone ${fmtMs(w6.podGoneAfterLeaseMs)} after lease, state ${w6.finalState}, cancelled=${w6.commandCancelled}\n`,
    );
  }
  return 0;
}

