#!/usr/bin/env node
/**
 * Workload A: Python data processing at >100 MiB.
 *
 * Generates a deterministic CSV directly to disk, streams it into the sandbox,
 * installs pandas, runs grouping/filtering, downloads a large filtered artifact
 * and verifies every result independently.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { SandboxClient, type SessionHandle } from "@x402s/sdk";
import { parseGroupedCsv, type Summary } from "./lib.js";

const API = process.env.API_URL ?? "http://localhost:8080";
const ROWS = Number(process.env.ROWS ?? 6_000_000);
const CATEGORIES = ["alpha", "beta", "gamma", "delta", "epsilon"];

function assertOk<T extends { ok?: boolean; error?: unknown }>(value: T, label: string): T {
  if (value.ok === false) throw new Error(`${label} failed: ${JSON.stringify(value.error)}`);
  return value;
}

async function generate(path: string): Promise<{ expected: Summary; grouped: Map<string, { rows: number; sum: number }> }> {
  const stream = createWriteStream(path);
  stream.write("id,category,value\n");
  const grouped = new Map<string, { rows: number; sum: number }>();
  let filtered = 0;
  let max = 0;
  let total = 0;
  let batch: string[] = [];
  for (let i = 0; i < ROWS; i += 1) {
    const category = CATEGORIES[i % CATEGORIES.length]!;
    const value = (i * 37) % 1000;
    batch.push(`${i},${category},${value}`);
    const bucket = grouped.get(category) ?? { rows: 0, sum: 0 };
    bucket.rows += 1;
    bucket.sum += value;
    grouped.set(category, bucket);
    if (value >= 500) filtered += 1;
    max = Math.max(max, value);
    total += value;
    if (batch.length >= 10_000) {
      if (!stream.write(`${batch.join("\n")}\n`)) await once(stream, "drain");
      batch = [];
    }
  }
  if (batch.length) stream.write(`${batch.join("\n")}\n`);
  await new Promise<void>((resolve, reject) => {
    stream.on("error", reject);
    stream.end(resolve);
  });
  return {
    expected: { rows: ROWS, filteredRows: filtered, categories: CATEGORIES.length, maxValue: max, meanValue: total / ROWS },
    grouped,
  };
}

async function usage(client: SandboxClient, handle: SessionHandle): Promise<string> {
  const result = assertOk(await client.exec(handle, {
    command: ["bash", "-lc", "cat /sys/fs/cgroup/memory.peak 2>/dev/null; df -m /workspace | tail -1"],
    timeoutMs: 10_000,
  }), "usage");
  return "stdout" in result ? result.stdout.trim() : "unavailable";
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "x402-python-"));
  const localInput = join(dir, "input.csv");
  const localFiltered = join(dir, "filtered.csv");
  const generated = await generate(localInput);
  const inputBytes = (await stat(localInput)).size;
  console.log(`input: ${ROWS} rows, ${(inputBytes / 1024 ** 2).toFixed(2)} MiB`);
  const started = performance.now();
  const client = new SandboxClient({ apiUrl: API, paymentMode: "mock", log: (line) => console.log(line) });
  let handle: SessionHandle | undefined;
  try {
    handle = await client.createSession({ tier: "custom", durationSeconds: 600, cpuMillis: 1_000, memoryMiB: 1_024, diskMiB: 1_024 });
    const ready = await client.waitForReady(handle);
    console.log(`ready: ${ready.state} in ${(performance.now() - started).toFixed(0)} ms`);

    const uploadStarted = performance.now();
    await client.uploadFile(handle, localInput, "/workspace/input.csv");
    const uploadMs = performance.now() - uploadStarted;
    console.log(`upload: ${uploadMs.toFixed(0)} ms, ${(inputBytes / 1024 ** 2 / (uploadMs / 1000)).toFixed(2)} MiB/s`);

    const installStarted = performance.now();
    const install = assertOk(await client.exec(handle, {
      command: ["python3", "-m", "pip", "install", "--target", "/workspace/.deps", "pandas"],
      timeoutMs: 300_000,
    }), "pip install");
    if ("stderr" in install && install.exitCode !== 0) throw new Error(install.stderr.slice(-1000));
    console.log(`pip install: ${(performance.now() - installStarted).toFixed(0)} ms`);

    assertOk(await client.putFile(handle, {
      path: "/workspace/process.py",
      data: await readFile(fileURLToPath(new URL("./process.py", import.meta.url))),
    }), "upload script");

    const execStarted = performance.now();
    const run = assertOk(await client.exec(handle, {
      command: ["python3", "/workspace/process.py"],
      env: { PYTHONPATH: "/workspace/.deps" },
      timeoutMs: 300_000,
    }), "python");
    if ("stderr" in run && run.exitCode !== 0) throw new Error(run.stderr.slice(-2000));
    console.log(`python: ${(performance.now() - execStarted).toFixed(0)} ms`);

    const result = assertOk(await client.getFile(handle, "/workspace/result.csv"), "result");
    const summaryFile = assertOk(await client.getFile(handle, "/workspace/summary.json"), "summary");
    if (!("dataBase64" in result) || !("dataBase64" in summaryFile)) throw new Error("missing payload");
    const actual = JSON.parse(Buffer.from(summaryFile.dataBase64, "base64").toString("utf8")) as Summary;
    const actualGrouped = parseGroupedCsv(Buffer.from(result.dataBase64, "base64").toString("utf8"));
    for (const [category, expected] of generated.grouped) {
      const row = actualGrouped.get(category);
      if (!row || row.rows !== expected.rows || row.sum !== expected.sum) throw new Error(`group mismatch ${category}`);
    }
    if (
      actual.rows !== generated.expected.rows ||
      actual.filteredRows !== generated.expected.filteredRows ||
      actual.maxValue !== generated.expected.maxValue ||
      Math.abs(actual.meanValue - generated.expected.meanValue) > 1e-9
    ) throw new Error(`summary mismatch: ${JSON.stringify(actual)}`);
    console.log(`verified summary: ${JSON.stringify(actual)}`);

    const downloadStarted = performance.now();
    await client.downloadFile(handle, "/workspace/filtered.csv", localFiltered);
    const filteredBytes = (await stat(localFiltered)).size;
    console.log(`filtered download: ${(performance.now() - downloadStarted).toFixed(0)} ms, ${(filteredBytes / 1024 ** 2).toFixed(2)} MiB`);
    const filteredLines = await new Promise<number>((resolve, reject) => {
      let lines = 0;
      const stream = createReadStream(localFiltered);
      stream.on("data", (chunk: string | Buffer) => { for (const byte of Buffer.from(chunk)) if (byte === 10) lines += 1; });
      stream.on("error", reject);
      stream.on("end", () => resolve(lines));
    });
    if (filteredLines - 1 !== generated.expected.filteredRows) throw new Error(`filtered rows ${filteredLines - 1}`);
    console.log(`workspace usage: ${await usage(client, handle)}`);
    console.log(`total: ${(performance.now() - started).toFixed(0)} ms`);
  } finally {
    if (handle) await client.destroy(handle).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
