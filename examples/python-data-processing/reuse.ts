#!/usr/bin/env node
/**
 * Session economics: fresh sandbox per task vs one leased sandbox vs suspend.
 * Uses the Python workload fixture; all times are wall-clock milliseconds.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SandboxClient, type SessionHandle } from "@x402s/sdk";
import { makeCsv } from "./lib.js";

const client = new SandboxClient({
  apiUrl: process.env.API_URL ?? "http://localhost:8080",
  paymentMode: "mock",
});
const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const input = makeCsv();
const processScript = await readFile(here("process.py"));

function ok<T extends { ok?: boolean; error?: unknown }>(value: T, label: string): T {
  if (value.ok === false) throw new Error(`${label}: ${JSON.stringify(value.error)}`);
  return value;
}

async function install(handle: SessionHandle): Promise<void> {
  const result = ok(await client.exec(handle, {
    command: ["python3", "-m", "pip", "install", "--target", "/workspace/.deps", "pandas"],
    timeoutMs: 180_000,
  }), "pip");
  if ("stderr" in result && result.exitCode !== 0) throw new Error(result.stderr.slice(-500));
}

async function prepare(handle: SessionHandle): Promise<void> {
  ok(await client.putFile(handle, { path: "/workspace/input.csv", data: input.csv }), "input");
  ok(await client.putFile(handle, { path: "/workspace/process.py", data: processScript }), "script");
}

async function run(handle: SessionHandle): Promise<number> {
  const started = performance.now();
  const result = ok(await client.exec(handle, {
    command: ["python3", "/workspace/process.py"],
    env: { PYTHONPATH: "/workspace/.deps" },
    timeoutMs: 120_000,
  }), "python");
  if ("stderr" in result && result.exitCode !== 0) throw new Error(result.stderr.slice(-500));
  return performance.now() - started;
}

async function fresh(): Promise<number> {
  let total = 0;
  for (let i = 0; i < 3; i += 1) {
    const started = performance.now();
    const handle = await client.createSession({ tier: "custom", durationSeconds: 300, cpuMillis: 1_000, memoryMiB: 1_024, diskMiB: 1_024 });
    try {
      await client.waitForReady(handle);
      await prepare(handle);
      await install(handle);
      await run(handle);
    } finally {
      await client.destroy(handle).catch(() => undefined);
    }
    total += performance.now() - started;
  }
  return total;
}

async function reused(): Promise<{ total: number; installMs: number; runMs: number[] }> {
  const started = performance.now();
  const handle = await client.createSession({ tier: "custom", durationSeconds: 300, cpuMillis: 1_000, memoryMiB: 1_024, diskMiB: 1_024 });
  try {
    await client.waitForReady(handle);
    await prepare(handle);
    const installStarted = performance.now();
    await install(handle);
    const installMs = performance.now() - installStarted;
    const runMs = [];
    for (let i = 0; i < 3; i += 1) runMs.push(await run(handle));
    return { total: performance.now() - started, installMs, runMs };
  } finally {
    await client.destroy(handle).catch(() => undefined);
  }
}

async function suspended(): Promise<{ total: number; installMs: number; suspendMs: number; resumeMs: number; runMs: number[] }> {
  const started = performance.now();
  const handle = await client.createSession({
    tier: "custom",
    durationSeconds: 300,
    cpuMillis: 1_000,
    memoryMiB: 1_024,
    diskMiB: 1_024,
    idlePolicy: { maxIdleSeconds: 300, suspendedDurationSeconds: 300, autoResume: false },
  });
  try {
    await client.waitForReady(handle);
    await prepare(handle);
    const installStarted = performance.now();
    await install(handle);
    const installMs = performance.now() - installStarted;
    const runMs = [await run(handle)];
    const suspendStarted = performance.now();
    await client.suspend(handle);
    const suspendMs = performance.now() - suspendStarted;
    const resumeStarted = performance.now();
    await client.resume(handle);
    const resumeMs = performance.now() - resumeStarted;
    runMs.push(await run(handle));
    return { total: performance.now() - started, installMs, suspendMs, resumeMs, runMs };
  } finally {
    await client.destroy(handle).catch(() => undefined);
  }
}

const freshTotal = await fresh();
const reuse = await reused();
const suspend = await suspended();
console.log(JSON.stringify({
  fresh3Ms: Math.round(freshTotal),
  reuse: { totalMs: Math.round(reuse.total), installMs: Math.round(reuse.installMs), runMs: reuse.runMs.map(Math.round) },
  suspend: { totalMs: Math.round(suspend.total), installMs: Math.round(suspend.installMs), suspendMs: Math.round(suspend.suspendMs), resumeMs: Math.round(suspend.resumeMs), runMs: suspend.runMs.map(Math.round) },
}, null, 2));
