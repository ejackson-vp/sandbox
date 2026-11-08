#!/usr/bin/env node
/**
 * Workload B: Node.js HTTP + SSE + WebSocket service.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SandboxClient, type SessionHandle } from "@x402s/sdk";

const API = process.env.API_URL ?? "http://localhost:8080";

function assertOk<T extends { ok?: boolean; error?: unknown }>(value: T, label: string): T {
  if (value.ok === false) throw new Error(`${label} failed: ${JSON.stringify(value.error)}`);
  return value;
}

async function waitHealthy(client: SandboxClient, handle: SessionHandle, timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const started = performance.now();
    try {
      const response = await client.http(handle, { port: 3000, path: "/health" });
      if (response.status === 200) return performance.now() - started;
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`service did not become healthy: ${String(last)}`);
}

async function main(): Promise<void> {
  const client = new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    log: (line) => console.log(line),
  });
  const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

  const totalStarted = performance.now();
  let handle: SessionHandle | undefined;
  try {
    handle = await client.createSession({
      tier: "custom",
      durationSeconds: 300,
      cpuMillis: 1_000,
      memoryMiB: 1_024,
      diskMiB: 1_024,
    });
    await client.waitForReady(handle);
    console.log(`ready in ${(performance.now() - totalStarted).toFixed(0)} ms`);

    for (const file of ["package.json", "app.js"]) {
      assertOk(await client.putFile(handle, {
        path: `/workspace/app/${file}`,
        data: await readFile(here(file)),
      }), `upload ${file}`);
    }

    const installStarted = performance.now();
    const install = assertOk(await client.exec(handle, {
      command: ["npm", "install", "--prefix", "/workspace/app", "--no-audit", "--no-fund"],
      env: { NPM_CONFIG_CACHE: "/workspace/.npm-cache" },
      timeoutMs: 180_000,
    }), "npm install");
    if ("stderr" in install && install.exitCode !== 0) throw new Error(`npm install failed: ${install.stderr.slice(-1000)}`);
    console.log(`npm install: ${(performance.now() - installStarted).toFixed(0)} ms`);

    const serviceStarted = performance.now();
    await client.startService(handle, {
      name: "node-http",
      command: ["node", "/workspace/app/app.js"],
      port: 3000,
    });
    const healthMs = await waitHealthy(client, handle);
    console.log(`service ready: ${(performance.now() - serviceStarted).toFixed(0)} ms (health ${healthMs.toFixed(0)} ms)`);

    const httpStarted = performance.now();
    const request = assertOk(await client.http(handle, {
      port: 3000,
      method: "POST",
      path: "/transform",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "sandbox" }),
    }), "transform");
    const httpMs = performance.now() - httpStarted;
    const body = JSON.parse(request.body.toString()) as { upper: string; reversed: string; length: number };
    if (request.status !== 200 || body.upper !== "SANDBOX" || body.reversed !== "xobdnas" || body.length !== 7) {
      throw new Error(`unexpected transform: ${request.status} ${request.body.toString()}`);
    }
    console.log(`http POST /transform: status=${request.status} in ${httpMs.toFixed(0)} ms`);

    const stream = await client.openHttpStream(handle, { port: 3000, path: "/events" });
    const sseStarted = performance.now();
    let sseText = "";
    while (true) {
      const chunk = await stream.read();
      if (chunk.chunk) sseText += chunk.chunk.toString();
      if (chunk.done) break;
      if (sseText.split("\n\n").filter(Boolean).length >= 3) break;
    }
    await stream.close();
    const events = sseText.split("\n\n").filter((part) => part.includes("data:"));
    if (events.length < 3) throw new Error(`expected 3 SSE events, got ${events.length}: ${sseText}`);
    console.log(`SSE: ${events.length} events in ${(performance.now() - sseStarted).toFixed(0)} ms`);

    const ws = await client.openWebSocket(handle, { port: 3000, path: "/ws" });
    const wsStarted = performance.now();
    const replies: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      await ws.send(`message-${i}`);
      const part = await ws.read();
      if (part.data) replies.push(part.data.toString());
    }
    await ws.close();
    if (replies.join(",") !== "echo:message-1,echo:message-2,echo:message-3") {
      throw new Error(`unexpected WS replies: ${JSON.stringify(replies)}`);
    }
    console.log(`WebSocket: 3 round trips in ${(performance.now() - wsStarted).toFixed(0)} ms`);

    await client.stopService(handle, "node-http");
    console.log(`total: ${(performance.now() - totalStarted).toFixed(0)} ms`);
  } finally {
    if (handle) await client.destroy(handle).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
