#!/usr/bin/env node
/**
 * Workload C: Playwright. Attempts the workload on the stock guest image and
 * reports the missing browser runtime rather than weakening pod security.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SandboxClient } from "@x402s/sdk";

const client = new SandboxClient({
  apiUrl: process.env.API_URL ?? "http://localhost:8080",
  paymentMode: "mock",
  allowInsecureDev: true,
  log: (line) => console.log(line),
});
const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

function ok<T extends { ok?: boolean; error?: unknown }>(value: T, label: string): T {
  if (value.ok === false) throw new Error(`${label}: ${JSON.stringify(value.error)}`);
  return value;
}

let handle;
try {
  handle = await client.createSession({ tier: "custom", durationSeconds: 300, cpuMillis: 1_000, memoryMiB: 1_024, diskMiB: 1_024 });
  await client.waitForReady(handle);
  for (const file of ["package.json", "browser.js"]) {
    ok(await client.putFile(handle, { path: `/workspace/browser/${file}`, data: await readFile(here(file)) }), `upload ${file}`);
  }
  const installed = ok(await client.exec(handle, {
    command: ["npm", "install", "--prefix", "/workspace/browser", "--no-audit", "--no-fund"],
    env: { NPM_CONFIG_CACHE: "/workspace/.npm-cache" },
    timeoutMs: 180_000,
  }), "npm install");
  if ("stderr" in installed && installed.exitCode !== 0) throw new Error(installed.stderr.slice(-1000));

  const inventory = ok(await client.exec(handle, {
    command: ["bash", "-lc", "command -v chromium || command -v chromium-browser || command -v google-chrome || true; ls -l /dev/shm 2>/dev/null; nproc"],
  }), "browser inventory");
  console.log(`browser inventory: ${"stdout" in inventory ? inventory.stdout.trim() : "unknown"}`);

  const run = ok(await client.exec(handle, {
    command: ["node", "/workspace/browser/browser.js"],
    env: { NODE_PATH: "/workspace/browser/node_modules" },
    timeoutMs: 120_000,
  }), "playwright");
  console.log(`playwright stdout: ${"stdout" in run ? run.stdout : ""}`);
  if ("stderr" in run && run.exitCode !== 0) {
    throw new Error(`browser runtime unavailable: ${run.stderr.slice(-2000)}`);
  }
  const shot = ok(await client.getFile(handle, "/workspace/screenshot.png"), "screenshot");
  if (!("dataBase64" in shot) || Buffer.from(shot.dataBase64, "base64").length === 0) throw new Error("empty screenshot");
  console.log("playwright workload OK");
} finally {
  if (handle) await client.destroy(handle).catch(() => undefined);
}
