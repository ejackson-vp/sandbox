#!/usr/bin/env node
/**
 * Workload B fault probes: service crash, suspend/resume, client disconnect and
 * lease expiry. These use only the public SDK.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SandboxClient, type SessionHandle } from "@x402s/sdk";

const client = new SandboxClient({
  apiUrl: process.env.API_URL ?? "http://localhost:8080",
  paymentMode: "mock",
  allowInsecureDev: true,
});
const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

function ok<T extends { ok?: boolean; error?: unknown }>(value: T, label: string): T {
  if (value.ok === false) throw new Error(`${label}: ${JSON.stringify(value.error)}`);
  return value;
}

async function healthy(handle: SessionHandle, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await client.http(handle, { port: 3000, path: "/health" });
      if (response.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function uploadApp(handle: SessionHandle): Promise<void> {
  for (const file of ["package.json", "app.js"]) {
    ok(await client.putFile(handle, { path: `/workspace/app/${file}`, data: await readFile(here(file)) }), `upload ${file}`);
  }
  const install = ok(await client.exec(handle, {
    command: ["npm", "install", "--prefix", "/workspace/app", "--no-audit", "--no-fund"],
    env: { NPM_CONFIG_CACHE: "/workspace/.npm-cache" },
    timeoutMs: 180_000,
  }), "npm install");
  if ("stderr" in install && install.exitCode !== 0) throw new Error(install.stderr.slice(-1000));
}

async function start(handle: SessionHandle): Promise<void> {
  await client.startService(handle, { name: "node-http", command: ["node", "/workspace/app/app.js"], port: 3000 });
  if (!(await healthy(handle))) throw new Error("service did not become healthy");
}

async function probeCrash(handle: SessionHandle): Promise<void> {
  const kill = ok(await client.exec(handle, { command: ["pkill", "-f", "/workspace/app/app.js"] }), "kill service");
  if ("exitCode" in kill && kill.exitCode !== 0) throw new Error("could not kill service");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const up = await healthy(handle, 1000);
  if (up) throw new Error("service stayed healthy after crash");
  console.log("crash: service stopped responding as expected");
}

async function probeDisconnect(handle: SessionHandle): Promise<void> {
  const stream = await client.openHttpStream(handle, { port: 3000, path: "/events" });
  await stream.read();
  await stream.close();
  if (!(await healthy(handle))) throw new Error("service died after client disconnect");
  console.log("disconnect: service survived SSE client close");
}

async function main(): Promise<void> {
  const reusable = await client.createSession({
    tier: "custom",
    durationSeconds: 300,
    cpuMillis: 1_000,
    memoryMiB: 1_024,
    diskMiB: 1_024,
    idlePolicy: { maxIdleSeconds: 300, suspendedDurationSeconds: 300, autoResume: false },
  });
  try {
    await client.waitForReady(reusable);
    await uploadApp(reusable);
    await start(reusable);
    await probeCrash(reusable);
    await start(reusable);
    await probeDisconnect(reusable);

    await client.suspend(reusable);
    console.log("suspend: service is stopped with the checkpoint");
    await client.resume(reusable);
    const afterResume = await healthy(reusable, 1000);
    if (afterResume) throw new Error("service unexpectedly survived suspend/resume");
    console.log("resume: service is not running; workspace/files survive");
    await start(reusable);
    console.log("resume: explicit service restart succeeded");
  } finally {
    await client.destroy(reusable).catch(() => undefined);
  }

  const short = await client.createSession({ tier: "custom", durationSeconds: 5, cpuMillis: 500, memoryMiB: 512, diskMiB: 512 });
  try {
    await client.waitForReady(short);
    const expired = await new Promise<boolean>((resolve) => {
      const deadline = Date.now() + 15_000;
      const poll = async () => {
        try {
          const status = await client.status(short);
          if (["EXPIRED", "DESTROYED", "FAILED"].includes(status.state)) return resolve(true);
        } catch {
          return resolve(true);
        }
        if (Date.now() > deadline) return resolve(false);
        setTimeout(poll, 200);
      };
      void poll();
    });
    if (!expired) throw new Error("session did not expire");
    console.log("expiry: session reached a terminal state");
  } finally {
    await client.destroy(short).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
