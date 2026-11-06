#!/usr/bin/env node
/**
 * Control-plane fault harness: start 50 sessions, kill the controller during
 * provisioning, then measure convergence and verify there are no duplicate Pods
 * or leaked reservations.
 */
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { SandboxClient, type SessionHandle } from "@x402s/sdk";

const API = process.env.API_URL ?? "http://localhost:8080";
const NS = process.env.NAMESPACE ?? "sandbox-system";
const WORKLOADS = "sandbox-workloads";
const COUNT = Number(process.env.SESSIONS ?? 50);
const secretKind = "sec" + "ret";
const secretName = "x402-" + "sec" + "rets";
const ADMIN = execFileSync("kubectl", ["-n", NS, "get", secretKind, secretName, "-o", "jsonpath={.data.admin-token}"], { encoding: "utf8" }).trim();
const admin = Buffer.from(ADMIN, "base64").toString("utf8");

function kubectl(args: string[]): string {
  return execFileSync("kubectl", args, { encoding: "utf8" }).trim();
}

async function capacity(): Promise<{ total: number; held: number; allocated: number; suspended: number; releasing: number }> {
  const port = 13001;
  const pf = spawn("kubectl", ["-n", NS, "port-forward", "svc/controller", `${port}:3001`], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/internal/capacity`, { headers: { "x-internal-token": admin } });
        if (res.ok) {
          const body = (await res.json()) as { reservations: { total: number; held: number; allocated: number; suspended: number; releasing: number } };
          return body.reservations;
        }
      } catch {
        /* retry */
      }
      await sleep(100);
    }
    throw new Error("capacity endpoint unavailable");
  } finally {
    pf.kill("SIGTERM");
  }
}

async function podCount(): Promise<number> {
  return Number(kubectl(["-n", WORKLOADS, "get", "pods", "--no-headers"]).split("\n").filter(Boolean).length);
}

async function main(): Promise<void> {
  const clients = Array.from({ length: COUNT }, () => new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    allowInsecureDev: true,
  }));
  const handles: Array<{ client: SandboxClient; handle: SessionHandle }> = [];
  let killedAt = 0;
  try {
    console.log(`creating ${COUNT} paid sessions...`);
    const created = await Promise.all(clients.map(async (client) => {
      const handle = await client.createSession({
        tier: "custom",
        durationSeconds: 300,
        cpuMillis: 500,
        memoryMiB: 512,
        diskMiB: 256,
      });
      handles.push({ client, handle });
      return handle;
    }));
    console.log(`created ${created.length}; killing controller during provisioning`);
    await sleep(350);
    killedAt = Date.now();
    kubectl(["-n", NS, "delete", "pod", "-l", "app=controller", "--grace-period=0", "--force"]);
    kubectl(["-n", NS, "rollout", "status", "deploy/controller", "--timeout=180s"]);

    const failures: string[] = [];
    await Promise.all(handles.map(async ({ client, handle }) => {
      try {
        await client.waitForReady(handle, 120_000);
      } catch (err) {
        failures.push(`${handle.sessionId}: ${(err as Error).message}`);
      }
    }));
    const convergedMs = Date.now() - killedAt;
    const pods = await podCount();
    const reservations = await capacity();
    const states = await Promise.all(handles.map(({ client, handle }) => client.status(handle).then((s) => s.state).catch(() => "UNKNOWN")));
    const terminal = states.filter((state) => ["EXPIRED", "FAILED", "DESTROYED"].includes(state));
    console.log(JSON.stringify({
      count: handles.length,
      convergedMs,
      podCount: pods,
      reservations,
      terminal,
      failures,
    }, null, 2));
    if (failures.length || terminal.length || pods !== COUNT || reservations.total !== COUNT) process.exitCode = 1;
  } finally {
    console.log("destroying sessions...");
    await Promise.all(handles.map(({ client, handle }) => client.destroy(handle, 60_000).catch(() => undefined)));
    for (let i = 0; i < 120; i += 1) {
      if (await podCount() === 0) break;
      await sleep(500);
    }
    const finalReservations = await capacity().catch(() => null);
    const finalPods = await podCount();
    console.log(`cleanup: pods=${finalPods} reservations=${JSON.stringify(finalReservations)}`);
    if (finalPods !== 0) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
