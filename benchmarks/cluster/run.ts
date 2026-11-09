#!/usr/bin/env node
/**
 * Live-cluster benchmark runner.
 *
 * The harness in benchmarks/harness/ is kind/Docker-specific (docker exec,
 * image eviction, image IDs). This one talks only to the public API, so it can
 * run against the Talos cluster over Tailscale.
 *
 *   API_URL=https://sandbox-api.<tailnet>.ts.net \
 *     npx tsx benchmarks/cluster/run.ts startup --samples 30 --pace 1200
 *
 * Commands:
 *   startup   create -> READY -> first exec -> destroy, sequential
 *   exec      repeated execs in one session
 *   burst     N simultaneous creates, then READY latency and failures
 *
 * Every row records both the client-observed time and the server-side
 * (createdAt -> readyAt) time, because they answer different questions: the
 * first is what a user feels, the second is what the controller/provisioner did.
 */
import { SandboxClient } from "@x402s/sdk";
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API_URL = process.env.API_URL ?? "http://localhost:8080";
const SPEC = { tier: "short" as const, durationSeconds: 60, cpuMillis: 500, memoryMiB: 512, diskMiB: 256 };

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]!);
}

function summary(label: string, values: number[]): string {
  return `${label}: n=${values.length} p50=${pct(values, 50)}ms p95=${pct(values, 95)}ms p99=${pct(values, 99)}ms max=${Math.round(Math.max(...values, 0))}ms`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startup(samples: number, paceMs: number, outDir: string): Promise<void> {
  const client = new SandboxClient({ apiUrl: API_URL, paymentMode: "mock" });
  const rows: Array<Record<string, number | string>> = [];

  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    const handle = await client.createSession(SPEC);
    const paidMs = performance.now() - t0;
    const status = await client.waitForReady(handle);
    const readyMs = performance.now() - t0;

    const createdAt = status.createdAt ? Date.parse(status.createdAt) : NaN;
    const readyAt = status.readyAt ? Date.parse(status.readyAt) : NaN;
    const serverMs = Number.isFinite(createdAt) && Number.isFinite(readyAt) ? readyAt - createdAt : 0;

    const e0 = performance.now();
    const result = await client.exec(handle, { command: ["bash", "-lc", "true"] });
    const execMs = performance.now() - e0;
    if (result.ok === false) throw new Error(`exec failed: ${JSON.stringify(result.error)}`);

    const d0 = performance.now();
    await client.destroy(handle);
    const destroyMs = performance.now() - d0;

    rows.push({ i, paidMs: Math.round(paidMs), readyMs: Math.round(readyMs), serverMs, execMs: Math.round(execMs), destroyMs: Math.round(destroyMs) });
    process.stdout.write(`  ${i + 1}/${samples}: ready ${Math.round(readyMs)}ms (server ${serverMs}ms, pay ${Math.round(paidMs)}ms)\n`);
    if (paceMs > 0) await sleep(paceMs);
  }

  writeFileSync(join(outDir, "startup.json"), JSON.stringify(rows, null, 2));
  console.log(summary("client ready", rows.map((r) => r.readyMs as number)));
  console.log(summary("server ready", rows.filter((r) => (r.serverMs as number) > 0).map((r) => r.serverMs as number)));
  console.log(summary("payment+create", rows.map((r) => r.paidMs as number)));
  console.log(summary("first exec", rows.map((r) => r.execMs as number)));
  console.log(summary("destroy", rows.map((r) => r.destroyMs as number)));
}

async function execBench(samples: number, outDir: string): Promise<void> {
  const client = new SandboxClient({ apiUrl: API_URL, paymentMode: "mock" });
  const sandbox = await client.create(SPEC);
  const rows: number[] = [];
  try {
    await sandbox.exec({ command: ["bash", "-lc", "true"] });
    for (let i = 0; i < samples; i++) {
      const t0 = performance.now();
      const result = await sandbox.exec({ command: ["bash", "-lc", "true"] });
      const ms = performance.now() - t0;
      if (result.ok === false) throw new Error(`exec failed: ${JSON.stringify(result.error)}`);
      rows.push(Math.round(ms));
    }
  } finally {
    await sandbox.destroy();
  }
  writeFileSync(join(outDir, "exec.json"), JSON.stringify(rows, null, 2));
  console.log(summary("exec", rows));
}

async function burst(n: number, outDir: string): Promise<void> {
  const client = new SandboxClient({ apiUrl: API_URL, paymentMode: "mock" });
  const started = performance.now();
  const results = await Promise.allSettled(
    Array.from({ length: n }, async () => {
      const t0 = performance.now();
      const handle = await client.createSession(SPEC);
      const status = await client.waitForReady(handle, 300_000);
      const createdAt = status.createdAt ? Date.parse(status.createdAt) : NaN;
      const readyAt = status.readyAt ? Date.parse(status.readyAt) : NaN;
      await client.destroy(handle);
      return {
        readyMs: Math.round(performance.now() - t0),
        serverMs: Number.isFinite(createdAt) && Number.isFinite(readyAt) ? readyAt - createdAt : 0,
      };
    }),
  );
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ readyMs: number; serverMs: number }>).value);
  const failed = results.filter((r) => r.status === "rejected").length;
  writeFileSync(join(outDir, "burst.json"), JSON.stringify(results, null, 2));
  console.log(`burst n=${n}: ready ${ok.length}, failed ${failed}, wall ${Math.round(performance.now() - started)}ms`);
  console.log(summary("burst client ready", ok.map((r) => r.readyMs)));
  console.log(summary("burst server ready", ok.filter((r) => r.serverMs > 0).map((r) => r.serverMs)));
}

async function hold(n: number, holdMs: number, outDir: string): Promise<void> {
  const client = new SandboxClient({ apiUrl: API_URL, paymentMode: "mock" });
  const spec = { tier: "custom" as const, durationSeconds: 180, cpuMillis: 500, memoryMiB: 512, diskMiB: 256 };
  const created: Array<Awaited<ReturnType<SandboxClient["create"]>>> = [];
  let failed = 0;
  for (let i = 0; i < n; i++) {
    try {
      created.push(await client.create(spec));
      process.stdout.write(`${created.length} `);
    } catch (e) {
      failed++;
      console.log(`\nfail at ${i + 1}: ${String(e).slice(0, 160)}`);
      break;
    }
    // The per-payer bucket is a 30-request burst; pacing keeps the capacity
    // limit, not the rate limiter, as the thing under test.
    await sleep(1200);
  }
  const peak = created.length;
  writeFileSync(join(outDir, "hold.json"), JSON.stringify({ peak, failed }, null, 2));
  console.log(`\nhold: peak ${peak}, failed ${failed}`);
  await sleep(holdMs);
  for (const s of created) await s.destroy().catch(() => undefined);
  console.log("released");
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      samples: { type: "string", default: "20" },
      pace: { type: "string", default: "0" },
      n: { type: "string", default: "25" },
      hold: { type: "string", default: "8000" },
      out: { type: "string" },
    },
  });
  const cmd = positionals[0];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = values.out ?? join("benchmarks", "results", `cluster-${cmd}-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  console.log(`# ${cmd} api=${API_URL} out=${outDir}`);

  if (cmd === "startup") await startup(Number(values.samples), Number(values.pace), outDir);
  else if (cmd === "exec") await execBench(Number(values.samples), outDir);
  else if (cmd === "burst") await burst(Number(values.n), outDir);
  else if (cmd === "hold") await hold(Number(values.n), Number(values.hold), outDir);
  else {
    console.error("usage: run.ts <startup|exec|burst> [--samples N] [--pace MS] [--n N]");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
