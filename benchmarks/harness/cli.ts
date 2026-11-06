#!/usr/bin/env node
/**
 * Benchmark CLI.
 *
 *   npx tsx benchmarks/harness/cli.ts env
 *   npx tsx benchmarks/harness/cli.ts smoke
 *   npx tsx benchmarks/harness/cli.ts startup --samples 100
 *   npx tsx benchmarks/harness/cli.ts density --levels 1,5,10,25 --mode idle
 *   npx tsx benchmarks/harness/cli.ts workloads
 *   npx tsx benchmarks/harness/cli.ts reliability
 *
 * All scenarios use the real API, controller, relay and sandbox pods through the
 * SDK. Payments are always mock x402.
 */
import { parseArgs } from "node:util";
import type { BenchOptions as Opts } from "./lib/options.js";
import { Bench } from "./lib/runner.js";
import { API_URL, captureHost, allocatedRequests, sandboxPodCount, nodes } from "./lib/env.js";
import { sleep } from "./lib/util.js";
import { runSmoke } from "./scenarios/smoke.js";
import { runStartup } from "./scenarios/startup.js";
import { runDensity } from "./scenarios/density.js";
import { runWorkloads } from "./scenarios/workloads.js";
import { runReliability } from "./scenarios/reliability.js";
import { runBurst } from "./scenarios/burst.js";
import { runSoak } from "./scenarios/soak.js";

const HELP = `x402 sandbox benchmarks (real cluster, mock payments)

Usage: tsx benchmarks/harness/cli.ts <command> [options]

Commands:
  env            print host/cluster environment and exit
  smoke          one paid session, hello + compute (safe default)
  startup        cold/warm session startup distributions
  density        concurrent sessions: idle | cpu | mixed
  workloads      representative workloads (hello, compute, fs, pip, multi, expiry)
  reliability    bounded fault injection (restarts, cancel, disconnect, expiry)
  burst          N simultaneous paid creates (arrival-rate spike)
  soak           steady traffic with periodic control-plane faults

Options:
  --samples <n>        startup iterations (default 100 warm / 10 cold)
  --levels <csv>       density/burst levels (default 1,5,10,25)
  --mode <m>           density mode: idle | cpu | mixed (default idle)
  --tier <t>           short|standard|extended|long|custom (default custom)
  --duration <s>       lease seconds (default 180 for density, 60 for startup)
  --cpu <millis>       CPU limit for custom sessions (default 500)
  --memory <MiB>       memory limit for custom sessions (default 512)
  --disk <MiB>         disk limit for custom sessions (default 256)
  --cold               cold-image startup mode (requires a registry-backed image)
  --image-ref <ref>    registry image ref for cold tests (patches the controller)
  --concurrency <n>    parallelism for setup/teardown (default 10)
  --rate <n/s>         soak create rate (default 0.5)
  --fault-every <s>    seconds between soak faults (default 90)
  --pace <ms>          sleep between startup samples (default 0)
  --max <n>            hard cap on concurrent sandboxes (default 25)
  --yes                required for --max > 25 or --levels above 25
  --no-cleanup         keep sessions/pods for inspection
  --out <runId>        reuse a run directory
  --json               print raw JSON instead of tables
`;


function parse(): { command: string; opts: Opts } {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      samples: { type: "string" },
      levels: { type: "string" },
      mode: { type: "string" },
      tier: { type: "string" },
      duration: { type: "string" },
      cpu: { type: "string" },
      memory: { type: "string" },
      disk: { type: "string" },
      cold: { type: "boolean", default: false },
      "image-ref": { type: "string" },
      concurrency: { type: "string" },
      rate: { type: "string" },
      "fault-every": { type: "string" },
      pace: { type: "string" },
      max: { type: "string" },
      yes: { type: "boolean", default: false },
      "no-cleanup": { type: "boolean", default: false },
      out: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const mode = (values.mode as Opts["mode"] | undefined) ?? "idle";
  if (!["idle", "cpu", "mixed"].includes(mode)) throw new Error(`invalid --mode ${mode}`);
  const tier = (values.tier as Opts["tier"] | undefined) ?? "custom";
  if (!["short", "standard", "extended", "long", "custom"].includes(tier)) throw new Error(`invalid --tier ${tier}`);
  return {
    command: positionals[0] ?? "help",
    opts: {
      samples: Number(values.samples ?? 0) || 0,
      levels: String(values.levels ?? "1,5,10,25")
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isInteger(v) && v > 0),
      mode,
      tier,
      duration: Number(values.duration ?? 0) || 0,
      cpuMillis: Number(values.cpu ?? 500),
      memoryMiB: Number(values.memory ?? 512),
      diskMiB: Number(values.disk ?? 256),
      cold: Boolean(values.cold),
      imageRef: values["image-ref"] as string | undefined,
      concurrency: Math.min(50, Math.max(1, Number(values.concurrency ?? 10))),
      rate: Math.min(20, Math.max(0.05, Number(values.rate ?? 0.5))),
      faultEvery: Math.max(15, Number(values["fault-every"] ?? 90)),
      paceMs: Math.min(10_000, Math.max(0, Number(values.pace ?? 0))),
      max: Number(values.max ?? 25),
      yes: Boolean(values.yes),
      cleanup: !values["no-cleanup"],
      runId: values.out as string | undefined,
      json: Boolean(values.json),
    },
  };
}

async function main(): Promise<number> {
  const { command, opts } = parse();

  if (command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "env") {
    const host = captureHost();
    const n = nodes();
    const alloc = allocatedRequests();
    process.stdout.write(
      JSON.stringify({ host, nodes: n, workerAllocated: alloc, api: API_URL, sandboxPods: sandboxPodCount() }, null, 2) + "\n",
    );
    return 0;
  }

  if (!["smoke", "startup", "density", "workloads", "reliability", "burst", "soak"].includes(command)) {
    process.stderr.write(`unknown command ${command}\n\n${HELP}`);
    return 2;
  }

  const bench = new Bench(command, opts.runId);

  // Safety gate: refuse large loads unless explicitly acknowledged.
  const highest = command === "density" || command === "burst" ? Math.max(...opts.levels, 0) : 0;
  if (highest > opts.max) {
    if (!opts.yes) {
      const alloc = allocatedRequests();
      const estMem = highest * opts.memoryMiB;
      process.stderr.write(
        `refusing: level ${highest} exceeds --max ${opts.max}.\n` +
          `estimated memory if all requested: ${estMem} MiB; worker allocatable: ${(alloc.allocatableMemoryBytes / 1024 ** 2).toFixed(0)} MiB\n` +
          `re-run with --max ${highest} --yes after checking free memory\n`,
      );
      return 2;
    }
  }
  if (highest > 25 && !opts.yes) {
    process.stderr.write("refusing: levels above 25 require --yes\n");
    return 2;
  }

  bench.note(
    `start ${command}; host=${bench.host.platform}/${bench.host.arch} docker=${bench.host.dockerCpus}cpu/${(bench.host.dockerMemBytes / 1024 ** 3).toFixed(1)}GiB kvm=${bench.host.kvm}`,
  );

  let code = 0;
  try {
    switch (command) {
      case "smoke":
        code = await runSmoke(bench, opts);
        break;
      case "startup":
        code = await runStartup(bench, opts);
        break;
      case "density":
        code = await runDensity(bench, opts);
        break;
      case "workloads":
        code = await runWorkloads(bench, opts);
        break;
      case "reliability":
        code = await runReliability(bench, opts);
        break;
      case "burst":
        code = await runBurst(bench, opts);
        break;
      case "soak":
        code = await runSoak(bench, opts);
        break;
    }
  } catch (err) {
    bench.note(`scenario failed: ${(err as Error).message}`);
    code = 1;
  } finally {
    if (opts.cleanup) {
      const { swept } = await bench.cleanupAll();
      bench.note(`cleanup: swept ${swept} leftover sandbox pod(s)`);
    } else {
      bench.note("cleanup skipped (--no-cleanup)");
    }
    bench.finish({ exitCode: code });
    process.stdout.write(`\nresults: ${bench.runDir}\n`);
    await sleep(50);
  }
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${(err as Error).stack ?? (err as Error).message}\n`);
    process.exit(1);
  });
