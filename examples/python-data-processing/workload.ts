#!/usr/bin/env node
/**
 * Workload A: Python data processing.
 *
 * Generates 100k deterministic rows, uploads them, installs pandas into the
 * workspace, runs a pandas aggregation, downloads and verifies both outputs.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SandboxClient, type SessionHandle } from "@x402s/sdk";
import { makeCsv, parseGroupedCsv, type Summary } from "./lib.js";

const API = process.env.API_URL ?? "http://localhost:8080";
const ROWS = 100_000;

function assertOk<T extends { ok?: boolean; error?: unknown }>(value: T, label: string): T {
  if (value.ok === false) throw new Error(`${label} failed: ${JSON.stringify(value.error)}`);
  return value;
}

function parseGroupedCsv(text: string): Map<string, { rows: number; sum: number; mean: number }> {
  const [header, ...rows] = text.trim().split("\n");
  if (header !== "category,rows,value_sum,value_mean") {
    throw new Error(`unexpected result header: ${header}`);
  }
  return new Map(rows.map((line) => {
    const [category, count, sum, mean] = line.split(",");
    return [category!, { rows: Number(count), sum: Number(sum), mean: Number(mean) }];
  }));
}

async function usage(client: SandboxClient, handle: SessionHandle): Promise<string> {
  const result = assertOk(
    await client.exec(handle, {
      command: ["bash", "-lc", "cat /sys/fs/cgroup/memory.peak 2>/dev/null; df -m /workspace | tail -1"],
      timeoutMs: 10_000,
    }),
    "usage",
  );
  return "stdout" in result ? result.stdout.trim() : "unavailable";
}

async function main(): Promise<void> {
  const client = new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    allowInsecureDev: true,
    log: (line) => console.log(line),
  });
  const generated = makeCsv();
  console.log(`input: ${ROWS} rows, ${(generated.csv.byteLength / 1024 ** 2).toFixed(2)} MiB`);

  let handle: SessionHandle | undefined;
  const started = performance.now();
  try {
    handle = await client.createSession({
      tier: "custom",
      durationSeconds: 300,
      cpuMillis: 1_000,
      memoryMiB: 1_024,
      diskMiB: 1_024,
    });
    const ready = await client.waitForReady(handle);
    const readyMs = performance.now() - started;
    console.log(`ready: ${ready.state} in ${readyMs.toFixed(0)} ms`);

    const uploadStarted = performance.now();
    assertOk(await client.putFile(handle, { path: "/workspace/input.csv", data: generated.csv }), "upload");
    const uploadMs = performance.now() - uploadStarted;
    console.log(`upload: ${uploadMs.toFixed(0)} ms, ${(generated.csv.byteLength / 1024 ** 2 / (uploadMs / 1000)).toFixed(2)} MiB/s`);

    const installStarted = performance.now();
    const install = assertOk(
      await client.exec(handle, {
        command: ["python3", "-m", "pip", "install", "--target", "/workspace/.deps", "pandas"],
        timeoutMs: 180_000,
      }),
      "pip install",
    );
    const installMs = performance.now() - installStarted;
    console.log(`pip install: ${installMs.toFixed(0)} ms`);
    if ("stderr" in install && install.exitCode !== 0) {
      throw new Error(`pip install failed: ${install.stderr.slice(-1000)}`);
    }

    const script = await readFile(fileURLToPath(new URL("./process.py", import.meta.url)));
    assertOk(await client.putFile(handle, { path: "/workspace/process.py", data: script }), "upload script");

    const execStarted = performance.now();
    const run = assertOk(
      await client.exec(handle, {
        command: ["python3", "/workspace/process.py"],
        env: { PYTHONPATH: "/workspace/.deps" },
        timeoutMs: 120_000,
      }),
      "python",
    );
    const execMs = performance.now() - execStarted;
    if ("stderr" in run && run.exitCode !== 0) throw new Error(`python failed: ${run.stderr.slice(-1000)}`);
    console.log(`python: ${execMs.toFixed(0)} ms`);

    const downloadStarted = performance.now();
    const result = assertOk(await client.getFile(handle, "/workspace/result.csv"), "download result");
    const summaryFile = assertOk(await client.getFile(handle, "/workspace/summary.json"), "download summary");
    const downloadMs = performance.now() - downloadStarted;
    if (!("dataBase64" in result) || !("dataBase64" in summaryFile)) throw new Error("missing file payload");
    const resultText = Buffer.from(result.dataBase64, "base64").toString("utf8");
    const actual = JSON.parse(Buffer.from(summaryFile.dataBase64, "base64").toString("utf8")) as Summary;

    const actualGrouped = parseGroupedCsv(resultText);
    for (const [category, expected] of generated.grouped) {
      const row = actualGrouped.get(category);
      if (!row || row.rows !== expected.rows || row.sum !== expected.sum) {
        throw new Error(`group mismatch for ${category}: ${JSON.stringify(row)} vs ${JSON.stringify(expected)}`);
      }
    }
    if (
      actual.rows !== generated.expected.rows ||
      actual.filteredRows !== generated.expected.filteredRows ||
      actual.categories !== generated.expected.categories ||
      actual.maxValue !== generated.expected.maxValue ||
      Math.abs(actual.meanValue - generated.expected.meanValue) > 1e-9
    ) {
      throw new Error(`summary mismatch: ${JSON.stringify(actual)} vs ${JSON.stringify(generated.expected)}`);
    }

    console.log(`download: ${downloadMs.toFixed(0)} ms`);
    console.log(`verified summary: ${JSON.stringify(actual)}`);
    console.log(`workspace usage: ${await usage(client, handle)}`);
    console.log(`total: ${(performance.now() - started).toFixed(0)} ms`);
  } finally {
    if (handle) await client.destroy(handle).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
