import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchOptions } from "../lib/options.js";
import { WORKLOADS_DIR } from "../lib/options.js";
import { Bench, createAndReady, timedDestroy, timedExec, type SampleRow } from "../lib/runner.js";
import { evictImageFromWorker, kubectl, kubectlTry, waitForPodGone, workerHasImage } from "../lib/env.js";
import { PodWatcher } from "../lib/watch.js";
import { fmtMs, sleep, summarize } from "../lib/util.js";

const GUEST_IMAGE_DEFAULT = "x402-sandbox/guest:dev";

/** Patch the controller to use a registry-backed image ref (cold-start tests). */
function setGuestImage(ref: string | null): void {
  const value = ref ?? GUEST_IMAGE_DEFAULT;
  kubectl([
    "-n",
    "sandbox-system",
    "patch",
    "configmap",
    "control-config",
    "--type",
    "merge",
    "-p",
    JSON.stringify({ data: { GUEST_IMAGE: value } }),
  ]);
  kubectl(["-n", "sandbox-system", "rollout", "restart", "deploy/controller"]);
  kubectl(["-n", "sandbox-system", "rollout", "status", "deploy/controller", "--timeout=120s"]);
}

function warmSpec(opts: BenchOptions, durationSeconds: number) {
  return {
    tier: "custom" as const,
    durationSeconds,
    cpuMillis: opts.cpuMillis,
    memoryMiB: opts.memoryMiB,
    diskMiB: opts.diskMiB,
  };
}

/**
 * Startup distributions.
 *
 * Each sample: create (paid) -> READY -> first exec -> destroy -> pod gone.
 * Sequential by design: concurrent provisioning would change the measurement.
 */
export async function runStartup(bench: Bench, opts: BenchOptions): Promise<number> {
  const samples = opts.samples > 0 ? opts.samples : opts.cold ? 10 : 100;
  const durationSeconds = opts.duration > 0 ? opts.duration : 60;
  const spec = warmSpec(opts, durationSeconds);
  const rows: SampleRow[] = [];
  let originalImage: string | null = null;

  if (opts.cold) {
    if (!opts.imageRef) {
      bench.note("cold mode requires --image-ref <registry/image:tag>; skipping cold startup");
      return 2;
    }
    originalImage = kubectlTry([
      "-n",
      "sandbox-system",
      "get",
      "configmap",
      "control-config",
      "-o",
      "jsonpath={.data.GUEST_IMAGE}",
    ]).out;
    if (!workerHasImage(opts.imageRef)) {
      bench.note(`cold mode: image ${opts.imageRef} not present on worker; priming it once`);
      setGuestImage(opts.imageRef);
      const prime = await createAndReady(bench, spec, 240_000);
      await timedDestroy(bench, prime.handle);
    }
    setGuestImage(opts.imageRef);
    bench.note(`cold mode: GUEST_IMAGE=${opts.imageRef}`);
  }

  bench.note(
    `startup: ${samples} ${opts.cold ? "cold" : "warm"} samples, spec ${JSON.stringify(spec)}, sequential`,
  );

  const watcher = new PodWatcher();
  watcher.start();

  for (let i = 0; i < samples; i++) {
    const startedAt = new Date().toISOString();
    if (opts.cold) {
      evictImageFromWorker(opts.imageRef!);
      // Wait until containerd has dropped the image so the pull is real.
      for (let wait = 0; wait < 40 && workerHasImage(opts.imageRef!); wait++) await sleep(250);
      if (workerHasImage(opts.imageRef!)) {
        bench.note(`sample ${i}: could not evict image; stopping`);
        break;
      }
    }
    let row: SampleRow;
    try {
      const session = await createAndReady(bench, spec, opts.cold ? 240_000 : 120_000);
      const warmHit = session.timings?.warmPoolHit === 1;
      const podName = `sbx-${session.sessionId.replace(/^sbx_/, "")}`;
      let podAddedAt: number | undefined;
      let scheduledAt: number | undefined;
      let runningAt: number | undefined;
      let guestStartedTs: number | undefined;
      let guestHelloTs: number | undefined;
      if (!warmHit) {
        const marks = await watcher.waitForRunning(podName, 5000);
        podAddedAt = watcher.absolute(marks.addedAt);
        scheduledAt = watcher.absolute(marks.scheduledAt);
        runningAt = watcher.absolute(marks.runningAt);
        // Guest-side startup breakdown from its structured log (same host clock).
        const guestLog = kubectlTry(["-n", "sandbox-workloads", "logs", podName, "-c", "guest", "--tail=-1"]).out;
        for (const line of guestLog.split("\n")) {
          try {
            const entry = JSON.parse(line) as { event?: string; ts?: string };
            const ts = entry.ts ? Date.parse(entry.ts) : NaN;
            if (!Number.isFinite(ts)) continue;
            if (entry.event === "guest_started") guestStartedTs = ts;
            if (entry.event === "guest_hello_sent") guestHelloTs = ts;
          } catch {
            /* non-JSON line */
          }
        }
      }
      const first = await timedExec(bench, session.handle, ["bash", "-c", "echo ready"]);
      const destroyed = await timedDestroy(bench, session.handle);
      const podGoneMs = await waitForPodGone(session.sessionId, 60_000);
      const stages = {
        podAddedMs: podAddedAt === undefined ? undefined : podAddedAt - session.t0,
        scheduledMs: scheduledAt === undefined ? undefined : scheduledAt - session.t0,
        containerRunningMs: runningAt === undefined ? undefined : runningAt - session.t0,
        guestHelloMs: session.timings?.guestHelloAt === undefined ? undefined : session.timings.guestHelloAt - session.epochAtT0,
        readyMs: session.timings?.readyAt === undefined ? undefined : session.timings.readyAt - session.epochAtT0,
        guestProcessStartMs: guestStartedTs === undefined ? undefined : guestStartedTs - session.epochAtT0,
        guestHelloFromGuestMs: guestHelloTs === undefined ? undefined : guestHelloTs - session.epochAtT0,
        guestInitMs: guestStartedTs !== undefined && guestHelloTs !== undefined ? guestHelloTs - guestStartedTs : undefined,
        firstExecStartMs: session.readyObservedMs,
        firstExecEndMs: session.readyObservedMs + first.ms,
      };
      row = {
        scenario: "startup",
        iteration: i,
        tier: spec.tier,
        durationSeconds,
        startedAt,
        ok: Boolean(first.result) && destroyed.state === "DESTROYED" && podGoneMs !== null,
        createMs: session.createMs,
        readyObservedMs: session.readyObservedMs,
        firstExecMs: first.ms,
        sessionId: session.sessionId,
        destroyMs: destroyed.totalMs,
        podGoneMs: podGoneMs ?? undefined,
        totalMs: session.readyObservedMs + first.ms + destroyed.totalMs,
        server: session.timings,
        derived: session.derived,
        stages,
      };
      if (!first.result) {
        row.errorCode = first.errorCode;
        row.errorMessage = first.errorMessage;
      }
    } catch (err) {
      const e = err as { code?: string; message?: string };
      row = {
        scenario: "startup",
        iteration: i,
        tier: spec.tier,
        durationSeconds,
        startedAt,
        ok: false,
        errorCode: e.code ?? "exception",
        errorMessage: e.message,
      };
    }
    bench.append(row);
    rows.push(row);
    if (opts.paceMs > 0) await sleep(opts.paceMs);
    bench.note(
      `${i + 1}/${samples}: create ${fmtMs(row.createMs)} ready ${fmtMs(row.readyObservedMs)} ` +
        `serverReady ${fmtMs(row.derived?.serverReadyMs)} exec ${fmtMs(row.firstExecMs)} destroy ${fmtMs(row.destroyMs)}`,
    );
  }

  watcher.stop();
  if (opts.cold) {
    setGuestImage(originalImage && originalImage.length > 0 ? originalImage : null);
    bench.note("cold mode: restored controller image");
  }

  const ok = rows.filter((r) => r.ok);
  const metrics: Record<string, number[]> = {
    create: ok.map((r) => r.createMs ?? NaN),
    ready: ok.map((r) => r.readyObservedMs ?? NaN),
    serverReady: ok.map((r) => r.derived?.serverReadyMs ?? NaN),
    provision: ok.map((r) => r.derived?.serverProvisionMs ?? NaN),
    warmClaim: ok.map((r) => r.derived?.warmClaimMs ?? NaN),
    podObjectCreated: ok.map((r) => r.stages?.podAddedMs ?? NaN),
    scheduled: ok.map((r) =>
      r.stages?.scheduledMs !== undefined && r.stages?.podAddedMs !== undefined
        ? r.stages.scheduledMs - r.stages.podAddedMs
        : NaN,
    ),
    podToGuestHello: ok.map((r) =>
      r.stages?.guestHelloMs !== undefined && r.stages?.scheduledMs !== undefined
        ? r.stages.guestHelloMs - r.stages.scheduledMs
        : NaN,
    ),
    helloToReady: ok.map((r) => r.derived?.helloToReadyMs ?? NaN),
    readyToClientObserved: ok.map((r) => r.derived?.readyToClientObservedMs ?? NaN),
    firstExec: ok.map((r) => r.firstExecMs ?? NaN),
    destroy: ok.map((r) => r.destroyMs ?? NaN),
    podGone: ok.map((r) => r.podGoneMs ?? NaN),
  };
  const summary: Record<string, unknown> = {
    scenario: opts.cold ? "startup-cold" : "startup-warm",
    samples: rows.length,
    ok: ok.length,
    failed: rows.length - ok.length,
    warmHits: ok.filter((r) => r.server?.warmPoolHit === 1).length,
    errorCodes: [...new Set(rows.filter((r) => !r.ok).map((r) => r.errorCode))],
    distributions: Object.fromEntries(
      Object.entries(metrics).map(([k, v]) => [k, summarize(v.filter((n) => Number.isFinite(n)))]),
    ),
  };
  bench.writeJson("startup.summary.json", summary);
  bench.writeCsv(
    "startup.csv",
    rows.map((r) => ({
      iteration: r.iteration,
      ok: r.ok,
      errorCode: r.errorCode ?? "",
      createMs: r.createMs ?? "",
      readyMs: r.readyObservedMs ?? "",
      serverReadyMs: r.derived?.serverReadyMs ?? "",
      firstExecMs: r.firstExecMs ?? "",
      destroyMs: r.destroyMs ?? "",
      podGoneMs: r.podGoneMs ?? "",
      tickToProvisionMs: r.derived?.tickToProvisionMs ?? "",
      podCreateCallMs: r.derived?.podCreateCallMs ?? "",
      runningToHelloMs: r.derived?.runningToHelloMs ?? "",
      helloToReadyMs: r.derived?.helloToReadyMs ?? "",
      paymentVerifyMs: r.server?.paymentVerifyMs ?? "",
      paymentSettleMs: r.server?.paymentSettleMs ?? "",
      entitlementMs: r.server?.entitlementMs ?? "",
    })),
  );

  if (!opts.json) {
    process.stdout.write(`\nstartup (${opts.cold ? "cold" : "warm"}, n=${rows.length}, ok=${ok.length})\n`);
    for (const [name, dist] of Object.entries(summary.distributions as Record<string, ReturnType<typeof summarize>>)) {
      if (!dist) {
        process.stdout.write(`${name.padEnd(18)} n/a\n`);
        continue;
      }
      process.stdout.write(
        `${name.padEnd(18)} n=${String(dist.count).padEnd(4)} p50 ${fmtMs(dist.p50).padEnd(9)} p90 ${fmtMs(dist.p90).padEnd(9)} p95 ${fmtMs(dist.p95).padEnd(9)} p99 ${fmtMs(dist.p99).padEnd(9)} max ${fmtMs(dist.max)}\n`,
      );
    }
  }
  return rows.length > 0 && ok.length === rows.length ? 0 : 1;
}

export function readWorkload(name: string): Buffer {
  return readFileSync(join(process.cwd(), WORKLOADS_DIR, name));
}
