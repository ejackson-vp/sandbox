#!/usr/bin/env node
/**
 * Minimal public-SDK quickstart. No controller, database or Kubernetes imports.
 *
 *   npx tsx examples/sdk-quickstart/index.ts
 */
import { SandboxClient } from "@x402s/sdk";

const client = new SandboxClient({
  apiUrl: process.env.API_URL ?? "http://localhost:8080",
  paymentMode: "mock",
});

let sandbox: Awaited<ReturnType<SandboxClient["create"]>> | undefined;
try {
  sandbox = await client.create({
    durationSeconds: 60,
    cpuMillis: 1_000,
    memoryMiB: 1_024,
    diskMiB: 512,
  });
  console.log(`sandbox ${sandbox.id} is ready`);

  const result = await sandbox.exec({
    command: ["bash", "-lc", "echo hello from $HOSTNAME; uname -s"],
  });
  if (result.ok === false) throw new Error(JSON.stringify(result.error));
  process.stdout.write(result.stdout);
} finally {
  await sandbox?.destroy();
}
