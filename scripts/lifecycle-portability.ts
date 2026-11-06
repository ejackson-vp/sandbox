#!/usr/bin/env node
/**
 * Checkpoint portability demo.
 *
 * A checkpoint on a local-path PVC is node-pinned. This script proves the
 * controller fails fast when that node is cordoned, and resumes correctly once
 * the node is back.
 */
import { execFileSync } from "node:child_process";
import { SandboxClient, SandboxError } from "../sdk/src/index.js";

const API = process.env.API_URL ?? "http://localhost:8080";
const CONTEXT = process.env.KUBECTL_CONTEXT ?? "kind-x402-sandbox";

function kubectl(args: string[]): string {
  return execFileSync("kubectl", ["--context", CONTEXT, ...args], { encoding: "utf8" }).trim();
}

async function main(): Promise<void> {
  const client = new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    allowInsecureDev: true,
    log: (line) => console.log(line),
  });

  const handle = await client.createSession({
    tier: "custom",
    durationSeconds: 60,
    idlePolicy: { maxIdleSeconds: 300, suspendedDurationSeconds: 600, autoResume: false },
  });
  await client.waitForReady(handle);
  await client.putFile(handle, { path: "persist.txt", data: Buffer.from("portable?\n") });

  const podName = `sbx-${handle.sessionId.replace(/^sbx_/, "")}`;
  const node = kubectl(["-n", "sandbox-workloads", "get", "pod", podName, "-o", "jsonpath={.spec.nodeName}"]);
  console.log(`session is on node ${node}`);

  await client.suspend(handle);
  kubectl(["cordon", node]);
  try {
    let code: string | undefined;
    try {
      await client.resume(handle);
    } catch (err) {
      code = err instanceof SandboxError ? err.code : "unknown";
    }
    console.log(`resume on a cordoned node: ${code}`);
    if (code !== "resume_unavailable") {
      throw new Error(`expected resume_unavailable, got ${code}`);
    }
  } finally {
    kubectl(["uncordon", node]);
  }

  const resumed = await client.resume(handle);
  const read = await client.exec(handle, { command: ["cat", "persist.txt"] });
  const resumedNode = kubectl([
    "-n",
    "sandbox-workloads",
    "get",
    "pod",
    podName,
    "-o",
    "jsonpath={.spec.nodeName}",
  ]);
  const affinityNode = kubectl([
    "-n",
    "sandbox-workloads",
    "get",
    "pod",
    podName,
    "-o",
    "jsonpath={.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchFields[0].values[0]}",
  ]);
  console.log(
    `resumed ${resumed.state} on ${resumedNode} (affinity ${affinityNode}); ` +
      `workspace ${"stdout" in read ? read.stdout.trim() : "unreadable"}`,
  );
  await client.destroy(handle);

  if (
    !("stdout" in read) ||
    read.stdout.trim() !== "portable?" ||
    resumedNode !== node ||
    affinityNode !== node
  ) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
