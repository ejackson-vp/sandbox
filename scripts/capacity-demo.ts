#!/usr/bin/env node
/**
 * Capacity admission demo against a live cluster.
 *
 * Requires the controller to be deliberately constrained; the Make target sets
 * CAPACITY_NODE_MEMORY_MIB=700, capacity overhead 0, and one 1000m CPU node.
 *
 * A fits, B is rejected, A suspends, B takes the compute, A's resume is
 * rejected, B is destroyed, A resumes, and no reservations remain.
 */
import { SandboxClient, SandboxError } from "../sdk/src/index.js";

const API = process.env.API_URL ?? "http://localhost:8080";
const CONTROLLER = process.env.CONTROLLER_URL ?? "http://127.0.0.1:13001";
const ADMIN = process.env.CONTROLLER_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "";

const spec = {
  tier: "custom" as const,
  durationSeconds: 120,
  cpuMillis: 1_000,
  memoryMiB: 1_024,
  diskMiB: 256,
  baselineCpuMillis: 500,
  baselineMemoryMiB: 512,
  idlePolicy: { maxIdleSeconds: 600, suspendedDurationSeconds: 600, autoResume: false },
};

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function expectCapacityRejection(err: unknown, label: string): void {
  if (!(err instanceof SandboxError) || err.code !== "capacity_unavailable") {
    fail(`${label} should have been rejected with capacity_unavailable, got ${String(err)}`);
  }
  console.log(`${label}: rejected with capacity_unavailable`);
}

async function capacity(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(new URL("/internal/capacity", CONTROLLER), {
      headers: { "x-internal-token": ADMIN },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const client = new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    allowInsecureDev: true,
    log: (line) => console.log(line),
  });

  const before = await capacity();
  console.log("initial capacity:", JSON.stringify(before));

  console.log("\n1. admitting A");
  const a = await client.createSession(spec);
  await client.waitForReady(a);
  console.log(`A ready: ${a.sessionId}`);
  console.log("reservation:", JSON.stringify(await capacity()));

  console.log("\n2. attempting oversized B while A holds the node");
  let bRejected = false;
  try {
    await client.createSession(spec);
  } catch (err) {
    expectCapacityRejection(err, "B");
    bRejected = true;
  }
  if (!bRejected) fail("B should not have been admitted");

  console.log("\n3. suspending A");
  const suspended = await client.suspend(a);
  console.log(`A state: ${suspended.state}`);

  console.log("\n4. admitting B into the released compute");
  const b = await client.createSession(spec);
  await client.waitForReady(b);
  console.log(`B ready: ${b.sessionId}`);

  console.log("\n5. attempting to resume A while B holds the node");
  let resumeRejected = false;
  try {
    await client.resume(a);
  } catch (err) {
    expectCapacityRejection(err, "A resume");
    resumeRejected = true;
  }
  if (!resumeRejected) fail("A resume should have been rejected");

  console.log("\n6. destroying B");
  await client.destroy(b);

  console.log("\n7. retrying A resume until the release completes");
  let resumed = false;
  for (let i = 0; i < 30; i += 1) {
    try {
      const status = await client.resume(a);
      console.log(`A state: ${status.state}`);
      resumed = true;
      break;
    } catch (err) {
      if (!(err instanceof SandboxError) || err.code !== "capacity_unavailable") throw err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!resumed) fail("A never resumed after B was destroyed");

  console.log("\n8. destroying A and waiting for reservations to disappear");
  await client.destroy(a);
  for (let i = 0; i < 30; i += 1) {
    const view = await capacity();
    const reservations = (view?.reservations ?? {}) as { total?: number };
    if (!view || reservations.total === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const after = await capacity();
  console.log("final capacity:", JSON.stringify(after));
  const reservations = (after?.reservations ?? {}) as { total?: number };
  if (after && reservations.total !== 0) fail(`reservations leaked: ${JSON.stringify(after)}`);
  console.log("\ncapacity demo OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
