#!/usr/bin/env node
/**
 * Multi-node placement demo. Requires a two-worker kind cluster
 * (`make up-2w`). Creates several sessions and verifies that least-allocated
 * placement spread reservations across more than one eligible worker.
 */
import { SandboxClient } from "../sdk/src/index.js";

const API = process.env.API_URL ?? "http://localhost:8080";
const CONTROLLER = process.env.CONTROLLER_URL ?? "http://127.0.0.1:13001";
const ADMIN = process.env.CONTROLLER_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "";
const COUNT = Number(process.env.SESSIONS ?? 4);

interface CapacityView {
  nodes: Array<{
    id: string;
    eligible: boolean;
    reserved: { cpuMillicores: number; memoryBytes: number };
    available: { cpuMillicores: number; memoryBytes: number };
  }>;
  reservations: { total: number };
}

async function capacity(): Promise<CapacityView> {
  const res = await fetch(new URL("/internal/capacity", CONTROLLER), {
    headers: { "x-internal-token": ADMIN },
  });
  if (!res.ok) throw new Error(`capacity endpoint ${res.status}`);
  return (await res.json()) as CapacityView;
}

async function main(): Promise<void> {
  const client = new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    allowInsecureDev: true,
    log: (line) => console.log(line),
  });

  const handles = [];
  for (let i = 0; i < COUNT; i += 1) {
    const handle = await client.createSession({
      tier: "custom",
      durationSeconds: 120,
      cpuMillis: 500,
      memoryMiB: 512,
      diskMiB: 256,
      baselineCpuMillis: 500,
      baselineMemoryMiB: 256,
    });
    await client.waitForReady(handle);
    handles.push(handle);
  }

  const view = await capacity();
  const eligible = view.nodes.filter((node) => node.eligible);
  const used = eligible.filter((node) => node.reserved.cpuMillicores > 0);
  console.log(`eligible workers: ${eligible.map((n) => n.id).join(", ") || "(none)"}`);
  for (const node of eligible) {
    console.log(
      `  ${node.id}: reserved ${node.reserved.cpuMillicores}m / ${(node.reserved.memoryBytes / 1024 ** 2).toFixed(0)}MiB, available ${node.available.cpuMillicores}m`,
    );
  }
  console.log(`reservations: ${view.reservations.total}`);

  for (const handle of handles) await client.destroy(handle);
  if (eligible.length < 2) {
    throw new Error("placement demo requires at least two eligible workers (make up-2w)");
  }
  if (used.length < 2) {
    throw new Error(`least-allocated placement did not use multiple workers: ${JSON.stringify(used)}`);
  }
  console.log("placement demo OK: reservations spread across multiple workers");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
