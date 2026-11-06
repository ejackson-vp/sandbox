#!/usr/bin/env node
/**
 * 100 MiB streaming round trip through the public SDK. The fixture is generated
 * outside the timed region; chunking is automatic because the file exceeds the
 * legacy 8 MiB per-message limit.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxClient } from "@x402s/sdk";

const MiB = 1024 * 1024;
const sizeMiB = Number(process.env.SIZE_MIB ?? 100);
if (!Number.isInteger(sizeMiB) || sizeMiB < 1 || sizeMiB > 256) throw new Error("SIZE_MIB must be 1..256");
const dir = await mkdtemp(join(tmpdir(), "x402-large-"));
const local = join(dir, "large.bin");
const output = join(dir, "large.out");
const block = Buffer.alloc(MiB);
for (let i = 0; i < MiB; i += 1) block[i] = i & 0xff;
const writer = createWriteStream(local);
for (let i = 0; i < sizeMiB; i += 1) writer.write(block);
await new Promise((resolve) => writer.end(resolve));

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

const expected = await digest(local);
console.log(`fixture: ${statSync(local).size} bytes, sha256 ${expected}`);

const client = new SandboxClient({
  apiUrl: process.env.API_URL ?? "http://localhost:8080",
  paymentMode: "mock",
  allowInsecureDev: true,
});
let sandbox;
try {
  sandbox = await client.create({ durationSeconds: 300, cpuMillis: 1000, memoryMiB: 1024, diskMiB: 1024 });
  const before = process.memoryUsage().rss;
  const uploadStart = performance.now();
  await sandbox.upload(local, "/workspace/large.bin", {
    onProgress: (p) => {
      if (p.bytesTransferred % (20 * MiB) === 0 || p.bytesTransferred === p.totalBytes) {
        console.log(`upload ${p.bytesTransferred}/${p.totalBytes}`);
      }
    },
  });
  const uploadMs = performance.now() - uploadStart;

  const guest = await sandbox.exec({ command: ["sha256sum", "/workspace/large.bin"] });
  if (!guest.ok) throw new Error(JSON.stringify(guest.error));
  const guestDigest = guest.stdout.trim().split(/\s+/)[0];
  if (guestDigest !== expected) throw new Error("guest digest mismatch");
  const usage = await sandbox.exec({
    command: ["bash", "-lc", "cat /sys/fs/cgroup/memory.peak 2>/dev/null; df -m /workspace | tail -1"],
  });

  const downloadStart = performance.now();
  await sandbox.download("/workspace/large.bin", output, {
    onProgress: (p) => {
      if (p.bytesTransferred % (20 * MiB) === 0 || p.bytesTransferred === p.totalBytes) {
        console.log(`download ${p.bytesTransferred}/${p.totalBytes}`);
      }
    },
  });
  const downloadMs = performance.now() - downloadStart;
  const actual = await digest(output);
  if (actual !== expected) throw new Error("downloaded digest mismatch");
  const after = process.memoryUsage().rss;
  console.log(JSON.stringify({
    sizeMiB,
    uploadMs: Math.round(uploadMs),
    uploadMiBs: Number((sizeMiB / (uploadMs / 1000)).toFixed(2)),
    downloadMs: Math.round(downloadMs),
    downloadMiBs: Number((sizeMiB / (downloadMs / 1000)).toFixed(2)),
    sha256: actual,
    clientRssDeltaMiB: Number(((after - before) / MiB).toFixed(1)),
    guestUsage: usage.ok ? usage.stdout.trim() : "unavailable",
    transferOk: true,
  }, null, 2));
} finally {
  if (sandbox) await sandbox.destroy().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}
