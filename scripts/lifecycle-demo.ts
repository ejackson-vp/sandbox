#!/usr/bin/env node
/**
 * End-to-end checkpoint/resume demo against the live cluster.
 *
 * Creates a suspendable session, writes a file, suspends it, resumes it, and
 * verifies the file survived while the guest keypair rotated.
 */
import { SandboxClient } from "../sdk/src/index.js";

const API = process.env.API_URL ?? "http://localhost:8080";

async function main(): Promise<void> {
  const client = new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    allowInsecureDev: true,
    log: (line) => console.log(line),
  });

  const created = performance.now();
  const handle = await client.createSession({
    tier: "custom",
    durationSeconds: 60,
    idlePolicy: { maxIdleSeconds: 300, suspendedDurationSeconds: 600, autoResume: false },
  });
  const ready = await client.waitForReady(handle);
  console.log(`ready in ${(performance.now() - created).toFixed(0)} ms (${ready.state})`);

  await client.putFile(handle, { path: "persist.txt", data: Buffer.from("keep-me\n") });
  const keyBefore = handle.guestPublicKey ? Buffer.from(handle.guestPublicKey) : undefined;

  const suspendStarted = performance.now();
  const suspended = await client.suspend(handle);
  console.log(`suspended in ${(performance.now() - suspendStarted).toFixed(0)} ms (${suspended.state})`);

  const resumeStarted = performance.now();
  const resumed = await client.resume(handle);
  console.log(`resumed in ${(performance.now() - resumeStarted).toFixed(0)} ms (${resumed.state})`);

  const read = await client.exec(handle, { command: ["cat", "persist.txt"] });
  const keyAfter = handle.guestPublicKey ? Buffer.from(handle.guestPublicKey) : undefined;
  const rotated = Boolean(keyBefore && keyAfter && !keyBefore.equals(keyAfter));
  console.log(`workspace: ${"stdout" in read ? JSON.stringify(read.stdout.trim()) : "read failed"}`);
  console.log(`guest key rotated: ${rotated}`);

  await client.destroy(handle);
  if (!("stdout" in read) || read.stdout.trim() !== "keep-me" || !rotated) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
