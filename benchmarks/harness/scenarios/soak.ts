import type { BenchOptions } from "../lib/options.js";
import { Bench, createAndReady, timedDestroy, timedExec } from "../lib/runner.js";
import {
  kubectlTry,
  sandboxPodCount,
  waitForNoSandboxPods,
  warmPodCount,
} from "../lib/env.js";
import { fmtMs, sleep, summarize } from "../lib/util.js";

type FaultKind = "relay_restart" | "controller_restart" | "warm_pod_kill";

interface SoakFault {
  at: string;
  kind: FaultKind;
  recovered: boolean;
  durationMs: number;
  warmAfter: number;
  sandboxPodsAfter: number;
}

interface SoakIteration {
  i: number;
  at: string;
  ok: boolean;
  errorCode?: string;
  readyMs?: number;
  warmHit?: boolean;
  execMs?: number;
  destroyMs?: number;
  afterFault: boolean;
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

async function waitDeployment(name: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = kubectlTry(["-n", "sandbox-system", "rollout", "status", `deploy/${name}`, "--timeout=5s"]);
    if (res.ok) return true;
    await sleep(500);
  }
  return false;
}

async function injectFault(kind: FaultKind): Promise<boolean> {
  if (kind === "relay_restart") {
    kubectlTry(["-n", "sandbox-system", "delete", "pod", "-l", "app=relay", "--grace-period=0", "--force"]);
    return waitDeployment("relay", 120_000);
  }
  if (kind === "controller_restart") {
    kubectlTry(["-n", "sandbox-system", "delete", "pod", "-l", "app=controller", "--grace-period=0", "--force"]);
    return waitDeployment("controller", 180_000);
  }
  const pods = kubectlTry([
    "-n",
    "sandbox-workloads",
    "get",
    "pods",
    "-l",
    "x402.io/pool=warm",
    "-o",
    "name",
  ]);
  const first = pods.out.split("\n").map((s) => s.trim()).filter(Boolean)[0];
  if (!first) return false;
  kubectlTry(["-n", "sandbox-workloads", "delete", first, "--grace-period=0", "--force"]);
  return true;
}

function relaySessions(): number | null {
  const res = kubectlTry([
    "-n",
    "sandbox-system",
    "exec",
    "deploy/relay",
    "--",
    "node",
    "-e",
    "fetch('http://127.0.0.1:8443/healthz').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))",
  ]);
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.out) as { sessions?: number };
    return typeof parsed.sessions === "number" ? parsed.sessions : null;
  } catch {
    return null;
  }
}

function controllerDbBytes(): number | null {
  const res = kubectlTry([
    "-n",
    "sandbox-system",
    "exec",
    "deploy/controller",
    "--",
    "sh",
    "-c",
    "wc -c < /data/controller.db",
  ]);
  if (!res.ok) return null;
  const n = Number(res.out.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Soak: steady create/exec/destroy traffic with periodic control-plane faults.
 * The goal is not latency (startup/density own that) but drift: orphan pods,
 * relay entries, DB growth, and whether the pool recovers after a restart.
 */
export async function runSoak(bench: Bench, opts: BenchOptions): Promise<number> {
  const durationSeconds = opts.duration > 0 ? opts.duration : 600;
  const spec = specOf(opts, 30);
  const intervalMs = 1000 / opts.rate;
  const deadline = Date.now() + durationSeconds * 1000;
  const faults: SoakFault[] = [];
  const iterations: SoakIteration[] = [];
  const faultKinds: FaultKind[] = ["relay_restart", "controller_restart", "warm_pod_kill"];
  let faultIndex = 0;
  let nextFault = Date.now() + opts.faultEvery * 1000;
  let lastFaultAt = 0;

  bench.note(
    `soak: ${durationSeconds}s at ${opts.rate}/s, fault every ${opts.faultEvery}s ` +
      `(${faultKinds.join(", ")}), spec ${JSON.stringify(spec)}`,
  );

  let i = 0;
  while (Date.now() < deadline) {
    if (Date.now() >= nextFault) {
      const kind = faultKinds[faultIndex % faultKinds.length]!;
      faultIndex++;
      const t0 = Date.now();
      bench.note(`fault ${kind}: injecting`);
      const recovered = await injectFault(kind);
      const fault: SoakFault = {
        at: new Date().toISOString(),
        kind,
        recovered,
        durationMs: Date.now() - t0,
        warmAfter: warmPodCount(),
        sandboxPodsAfter: sandboxPodCount(),
      };
      faults.push(fault);
      lastFaultAt = Date.now();
      bench.note(
        `fault ${kind}: ${recovered ? "recovered" : "NOT recovered"} in ${fmtMs(fault.durationMs)}; ` +
          `warm ${fault.warmAfter}, session pods ${fault.sandboxPodsAfter}`,
      );
      nextFault = Date.now() + opts.faultEvery * 1000;
    }

    const iterationStart = Date.now();
    const at = new Date().toISOString();
    let row: SoakIteration;
    try {
      const session = await createAndReady(bench, spec, 120_000);
      const exec = await timedExec(bench, session.handle, ["bash", "-c", "echo soak"], { timeoutMs: 30_000 });
      const destroyed = await timedDestroy(bench, session.handle);
      row = {
        i,
        at,
        ok: Boolean(exec.result) && destroyed.state === "DESTROYED",
        readyMs: session.readyObservedMs,
        warmHit: session.timings?.warmPoolHit === 1,
        execMs: exec.ms,
        destroyMs: destroyed.totalMs,
        afterFault: lastFaultAt > 0 && Date.now() - lastFaultAt < 15_000,
      };
    } catch (err) {
      const e = err as { code?: string };
      row = {
        i,
        at,
        ok: false,
        errorCode: e.code ?? "exception",
        afterFault: lastFaultAt > 0 && Date.now() - lastFaultAt < 15_000,
      };
    }
    iterations.push(row);
    bench.append(row as never);
    i++;

    const elapsed = Date.now() - iterationStart;
    if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
  }

  await waitForNoSandboxPods(90_000);
  await sleep(30_000); // let the controller recycle/replenish after a relay restart
  const warmAfter = warmPodCount();
  const sandboxAfter = sandboxPodCount();
  const relayCount = relaySessions();
  const dbBytes = controllerDbBytes();
  const ok = iterations.filter((r) => r.ok);
  const failed = iterations.filter((r) => !r.ok);
  const ready = summarize(ok.map((r) => r.readyMs ?? NaN).filter(Number.isFinite));

  bench.writeJson("soak.summary.json", {
    spec,
    durationSeconds,
    rate: opts.rate,
    faultEverySeconds: opts.faultEvery,
    attempts: iterations.length,
    ok: ok.length,
    failed: failed.length,
    warmHits: ok.filter((r) => r.warmHit).length,
    errorCodes: [...new Set(failed.map((r) => r.errorCode ?? "unknown"))],
    ready,
    faults,
    final: {
      warmPods: warmAfter,
      sandboxPods: sandboxAfter,
      relaySessions: relayCount,
      controllerDbBytes: dbBytes,
    },
    measuredAt: new Date().toISOString(),
  });
  bench.writeCsv(
    "soak.csv",
    iterations.map((r) => ({
      i: r.i,
      at: r.at,
      ok: r.ok,
      errorCode: r.errorCode ?? "",
      readyMs: r.readyMs?.toFixed(0) ?? "",
      warmHit: r.warmHit ?? "",
      execMs: r.execMs?.toFixed(1) ?? "",
      destroyMs: r.destroyMs?.toFixed(0) ?? "",
      afterFault: r.afterFault,
    })),
  );
  bench.note(
    `soak done: ${ok.length}/${iterations.length} ok, warm ${ok.filter((r) => r.warmHit).length}, ` +
      `faults ${faults.filter((f) => f.recovered).length}/${faults.length} recovered, ` +
      `final warm ${warmAfter}, session pods ${sandboxAfter}, relay ${relayCount ?? "?"}, db ${dbBytes ?? "?"}B`,
  );
  return sandboxAfter === 0 && warmAfter > 0 ? 0 : 1;
}
