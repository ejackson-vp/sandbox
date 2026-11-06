import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchOptions } from "../lib/options.js";
import { WORKLOADS_DIR } from "../lib/options.js";
import { Bench, createAndReady, timedDestroy, timedExec } from "../lib/runner.js";
import { fmtMs, summarize } from "../lib/util.js";

/** Safe default: one paid session, two commands, full cleanup. */
export async function runSmoke(bench: Bench, opts: BenchOptions): Promise<number> {
  const spec = {
    tier: "custom" as const,
    durationSeconds: 60,
    cpuMillis: opts.cpuMillis,
    memoryMiB: opts.memoryMiB,
    diskMiB: opts.diskMiB,
  };
  bench.note(`smoke: creating ${JSON.stringify(spec)}`);
  const session = await createAndReady(bench, spec);
  bench.note(
    `ready in ${fmtMs(session.readyObservedMs)} (server ${fmtMs(session.derived.serverReadyMs)}); limits ${JSON.stringify(session.status.limits)}`,
  );

  const hello = await timedExec(bench, session.handle, ["python3", "-c", 'print("hello from the sandbox")']);
  const put = await bench.client.putFile(session.handle, {
    path: "/workspace/bench/hello.py",
    data: readFileSync(join(process.cwd(), WORKLOADS_DIR, "hello.py")),
  });
  const py = await timedExec(bench, session.handle, ["python3", "/workspace/bench/hello.py"]);
  const usage = await bench.usage(session.handle);
  const destroyed = await timedDestroy(bench, session.handle);

  const row = {
    scenario: "smoke",
    iteration: 0,
    tier: spec.tier,
    durationSeconds: spec.durationSeconds,
    startedAt: new Date().toISOString(),
    ok: Boolean(hello.result && put.ok && py.result && destroyed.state === "DESTROYED"),
    createMs: session.createMs,
    readyObservedMs: session.readyObservedMs,
    firstExecMs: hello.ms,
    destroyMs: destroyed.totalMs,
    server: session.timings,
    derived: session.derived,
    usage: usage ?? undefined,
  };
  bench.append(row as never);

  const summary = summarize([hello.ms, py.ms]);
  bench.note(
    `exec: python -c ${fmtMs(hello.ms)}, hello.py ${fmtMs(py.ms)} (n=${summary?.count}, p50 ${fmtMs(summary?.p50)}); ` +
      `usage anon=${((usage?.memAnonBytes ?? 0) / 1024 ** 2).toFixed(1)}MiB; destroy ${fmtMs(destroyed.totalMs)}`,
  );
  if (!opts.json) {
    process.stdout.write(
      `\nsmoke: create ${fmtMs(session.createMs)}, ready ${fmtMs(session.readyObservedMs)}, ` +
        `first exec ${fmtMs(hello.ms)}, destroy ${fmtMs(destroyed.totalMs)}\n`,
    );
  }
  return row.ok ? 0 : 1;
}
