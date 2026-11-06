#!/usr/bin/env node
/**
 * Lifecycle fault demo:
 *   1. a suspended workspace that disappears fails closed on resume;
 *   2. a suspended session survives a controller restart and still resumes.
 */
import { execFileSync } from "node:child_process";
import { SandboxClient, SandboxError } from "../sdk/src/index.js";

const API = process.env.API_URL ?? "http://localhost:8080";
const CONTEXT = process.env.KUBECTL_CONTEXT ?? "kind-x402-sandbox";

function kubectl(args: string[]): string {
  return execFileSync("kubectl", ["--context", CONTEXT, ...args], { encoding: "utf8" }).trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const client = new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    allowInsecureDev: true,
    log: (line) => console.log(line),
  });

  // 1. Missing workspace PVC.
  const broken = await client.createSession({
    tier: "custom",
    durationSeconds: 60,
    idlePolicy: { maxIdleSeconds: 300, suspendedDurationSeconds: 600, autoResume: false },
  });
  await client.waitForReady(broken);
  await client.suspend(broken);
  const pvc = `x402-ws-${broken.sessionId.replace(/^sbx_/, "")}`;
  kubectl(["-n", "sandbox-workloads", "delete", "pvc", pvc, "--ignore-not-found"]);
  let code: string | undefined;
  try {
    await client.resume(broken);
  } catch (err) {
    code = err instanceof SandboxError ? err.code : "unknown";
  }
  console.log(`resume after deleting the PVC: ${code}`);
  if (code !== "resume_unavailable") throw new Error(`expected resume_unavailable, got ${code}`);
  for (let i = 0; i < 40; i++) {
    const status = await client.status(broken).catch(() => null);
    if (!status || ["FAILED", "EXPIRED", "DESTROYED"].includes(status.state)) break;
    await sleep(250);
  }

  // 2. Controller restart while suspended.
  const survivor = await client.createSession({
    tier: "custom",
    durationSeconds: 60,
    idlePolicy: { maxIdleSeconds: 300, suspendedDurationSeconds: 600, autoResume: false },
  });
  await client.waitForReady(survivor);
  await client.putFile(survivor, { path: "survive.txt", data: Buffer.from("controller-restart\n") });
  await client.suspend(survivor);
  kubectl(["-n", "sandbox-system", "delete", "pod", "-l", "app=controller", "--grace-period=0", "--force"]);
  kubectl(["-n", "sandbox-system", "rollout", "status", "deploy/controller", "--timeout=180s"]);
  const resumed = await client.resume(survivor);
  const read = await client.exec(survivor, { command: ["cat", "survive.txt"] });
  console.log(
    `resume after controller restart: ${resumed.state}; workspace ` +
      `${"stdout" in read ? read.stdout.trim() : "unreadable"}`,
  );
  await client.destroy(survivor);
  await client.destroy(broken).catch(() => null);

  if (!("stdout" in read) || read.stdout.trim() !== "controller-restart") process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
