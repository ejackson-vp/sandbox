/** Clean restart-recovery measurements (no concurrent load). */
import { SandboxClient, FileSessionStore } from "../../../sdk/src/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kubectlTry } from "../lib/env.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const client = new SandboxClient({ apiUrl: "http://localhost:8080", paymentMode: "mock", allowInsecureDev: true, store: new FileSessionStore(mkdtempSync(join(tmpdir(), "rp-"))) });

function ready(name: string): boolean {
  const res = kubectlTry(["-n","sandbox-system","get","pods","-l",`app=${name}`,"-o",'jsonpath={range .items[*]}{.status.phase}{"\\t"}{.status.containerStatuses[0].ready}{"\\n"}{end}']);
  if (!res.ok) return false;
  return res.out.split("\n").filter(Boolean).some((l) => l.startsWith("Running") && l.trim().endsWith("true"));
}
async function wait(name: string, timeoutMs = 180000): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (ready(name)) return Date.now() - t0; await sleep(250); }
  return null;
}
async function restart(name: string): Promise<{ recoveryMs: number | null; execAfter: boolean }> {
  kubectlTry(["-n","sandbox-system","delete","pod","-l",`app=${name}`,"--grace-period=0","--force"]);
  const recoveryMs = await wait(name);
  let execAfter = false;
  try {
    const h = await client.createSession({ tier: "custom", durationSeconds: 60 });
    await client.waitForReady(h, 60000);
    const r = await client.exec(h, { command: ["echo", "after-restart"] });
    execAfter = Boolean(r.ok);
    await client.destroy(h, 30000).catch(() => null);
  } catch { execAfter = false; }
  return { recoveryMs, execAfter };
}

for (const name of ["controller", "relay", "api"]) {
  const r = await restart(name);
  console.log(JSON.stringify({ name, ...r }));
  await sleep(2000);
}
process.exit(0);
