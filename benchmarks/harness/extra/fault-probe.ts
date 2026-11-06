/** One-off diagnostic: run N sessions and capture the first failures. */
import { SandboxClient, FileSessionStore } from "../../../sdk/src/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kubectlTry } from "../lib/env.js";

const N = Number(process.argv[2] ?? "25");
const client = new SandboxClient({
  apiUrl: "http://localhost:8080", paymentMode: "mock", allowInsecureDev: true,
  store: new FileSessionStore(mkdtempSync(join(tmpdir(), "fp-"))),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const handles: any[] = [];
for (let i = 0; i < N; i++) {
  try { handles.push(await client.createSession({ tier: "custom", durationSeconds: 120, cpuMillis: 500, memoryMiB: 512, diskMiB: 256 })); }
  catch (e) { console.log("create failed", (e as any).code); }
  if (i % 5 === 4) await sleep(200);
}
console.log("created", handles.length);
const ready: any[] = [];
for (const h of handles) { try { await client.waitForReady(h, 120000); ready.push(h); } catch (e) { console.log("not ready", h.sessionId, (e as any).code ?? (e as Error).message); } }
console.log("ready", ready.length);
const failures: any[] = [];
for (let round = 0; round < 6; round++) {
  const results = await Promise.all(ready.map(async (h) => {
    try { const r = await client.exec(h, { command: ["bash", "-c", "echo tick"] }); return r.ok ? null : { h, code: r.error?.code }; }
    catch (e) { return { h, code: (e as any).code ?? "exc", msg: (e as Error).message }; }
  }));
  for (const f of results.filter(Boolean)) if (failures.length < 4) failures.push(f);
  await sleep(500);
}
console.log("failures", failures.map((f) => ({ id: f.h.sessionId, code: f.code, msg: f.msg })));
for (const f of failures.slice(0, 4)) {
  const pod = `sbx-${f.h.sessionId.replace(/^sbx_/, "")}`;
  const status = kubectlTry(["-n", "sandbox-workloads", "get", "pod", pod, "-o", "jsonpath={.status.phase}{\"\\t\"}{range .status.containerStatuses[*]}{.name}:{.state.terminated.exitCode}/{.state.terminated.reason} {end}{range .status.initContainerStatuses[*]}{.name}:{.state.terminated.exitCode}/{.state.terminated.reason} {end}"]);
  const logs = kubectlTry(["-n", "sandbox-workloads", "logs", pod, "-c", "guest", "--tail=6"]);
  console.log("\n==", pod, "status:", status.out || status.out);
  console.log(logs.out.slice(-1200));
}
await Promise.all(ready.map((h) => client.destroy(h, 30000).catch(() => null)));
process.exit(0);
