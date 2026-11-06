#!/usr/bin/env node
/** Interruption, resume, cancellation and quota probes for streaming transfers. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxClient, TransferError, type Sandbox } from "@x402s/sdk";

const MiB = 1024 * 1024;
const dir = await mkdtemp(join(tmpdir(), "x402-fault-"));
const local = join(dir, "data.bin");
const output = join(dir, "data.out");
const block = Buffer.alloc(MiB);
for (let i = 0; i < MiB; i += 1) block[i] = (i * 7) & 0xff;
const writer = createWriteStream(local);
for (let i = 0; i < 40; i += 1) writer.write(block);
await new Promise((resolve) => writer.end(resolve));

function digest(): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(local);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

const client = new SandboxClient({ apiUrl: process.env.API_URL ?? "http://localhost:8080", paymentMode: "mock", allowInsecureDev: true });
let sandbox: Sandbox | undefined;
try {
  sandbox = await client.create({ durationSeconds: 300, cpuMillis: 1000, memoryMiB: 1024, diskMiB: 1024 });
  const expected = await digest();

  let interrupted: TransferError | undefined;
  try {
    await sandbox.upload(local, "/workspace/data.bin", {
      onProgress: (p) => { if (p.bytesTransferred >= 10 * MiB) throw new Error("simulated disconnect"); },
    });
  } catch (err) {
    if (!(err instanceof TransferError) || !err.transferId) throw err;
    interrupted = err;
  }
  if (!interrupted) throw new Error("upload interruption was not surfaced");
  const destination = await sandbox.exec({ command: ["bash", "-lc", "test -e /workspace/data.bin && echo exists || echo absent"] });
  if (!destination.ok || destination.stdout.trim() !== "absent") throw new Error("partial upload became visible");
  await sandbox.upload(local, "/workspace/data.bin", { transferId: interrupted.transferId });
  console.log("upload resume: OK");

  let downloadInterrupted: TransferError | undefined;
  try {
    await sandbox.download("/workspace/data.bin", output, {
      onProgress: (p) => { if (p.bytesTransferred >= 10 * MiB) throw new Error("simulated disconnect"); },
    });
  } catch (err) {
    if (!(err instanceof TransferError) || !err.transferId) throw err;
    downloadInterrupted = err;
  }
  if (!downloadInterrupted) throw new Error("download interruption was not surfaced");
  await sandbox.download("/workspace/data.bin", output, { transferId: downloadInterrupted.transferId });
  const got = await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(output);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
  if (got !== expected) throw new Error("resumed download digest mismatch");
  console.log("download resume: OK");

  const controller = new AbortController();
  try {
    await sandbox.upload(local, "/workspace/cancelled.bin", {
      signal: controller.signal,
      onProgress: (p) => { if (p.bytesTransferred >= 5 * MiB) controller.abort(); },
    });
  } catch (err) {
    if (!(err instanceof TransferError) || err.code !== "transfer_cancelled") throw err;
  }
  console.log("cancellation: OK");

  const small = await client.create({ durationSeconds: 60, cpuMillis: 500, memoryMiB: 512, diskMiB: 16 });
  try {
    try {
      await small.upload(local, "/workspace/too-large.bin");
      throw new Error("quota upload unexpectedly succeeded");
    } catch (err) {
      if (!(err instanceof TransferError) || !["quota_exceeded", "transfer_too_large"].includes(err.code)) throw err;
      console.log(`quota: ${err.code}`);
    }
  } finally {
    await small.destroy();
  }
} finally {
  if (sandbox) await sandbox.destroy().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}
