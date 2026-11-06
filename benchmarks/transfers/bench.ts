#!/usr/bin/env node
/** Streaming transfer benchmark: sizes and chunk sizes through the public SDK. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxClient } from "@x402s/sdk";

const MiB = 1024 * 1024;
const dir = await mkdtemp(join(tmpdir(), "x402-bench-"));
const client = new SandboxClient({ apiUrl: process.env.API_URL ?? "http://localhost:8080", paymentMode: "mock", allowInsecureDev: true });
const sizes = (process.env.SIZES ?? "1K,1M,8M,32M,100M").split(",").map((v) => {
  const m = /^(\d+)(K|M)$/.exec(v.trim());
  if (!m) throw new Error(`invalid size ${v}`);
  return Number(m[1]) * (m[2] === "M" ? MiB : 1024);
});
const chunkSizes = (process.env.CHUNKS ?? "262144,524288,1048576").split(",").map(Number);

function fileDigest(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function fixture(name: string, size: number): Promise<{ path: string; digest: string }> {
  const path = join(dir, name);
  const block = Buffer.alloc(Math.min(MiB, size), 0x5a);
  const out = createWriteStream(path);
  let left = size;
  while (left > 0) {
    const chunk = block.subarray(0, Math.min(block.length, left));
    out.write(chunk);
    left -= chunk.length;
  }
  await new Promise((resolve) => out.end(resolve));
  return { path, digest: await fileDigest(path) };
}

// This function is intentionally explicit: public uploadFile/downloadFile force
// streaming even for small files, which the facade would otherwise send inline.
async function run(size: number, chunkSize: number): Promise<Record<string, unknown>> {
  const src = await fixture(`s-${size}-${chunkSize}.bin`, size);
  const dst = join(dir, `d-${size}-${chunkSize}.bin`);
  const sandbox = await client.create({ durationSeconds: 300, cpuMillis: 1000, memoryMiB: 1024, diskMiB: Math.max(256, Math.ceil(size / MiB) + 64) });
  try {
    const before = process.memoryUsage().rss;
    const upStart = performance.now();
    const up = await client.uploadFile(sandbox.handle, src.path, "/workspace/payload.bin", { chunkSize });
    const upMs = performance.now() - upStart;
    const downStart = performance.now();
    let firstByteAt = 0;
    const down = await client.downloadFile(sandbox.handle, "/workspace/payload.bin", dst, {
      chunkSize,
      onProgress: (p) => { if (!firstByteAt && p.bytesTransferred > 0) firstByteAt = performance.now(); },
    });
    const downMs = performance.now() - downStart;
    if (up.digest !== src.digest || down.digest !== src.digest) throw new Error("digest mismatch");
    const usage = await client.exec(sandbox.handle, { command: ["bash", "-lc", "cat /sys/fs/cgroup/memory.peak 2>/dev/null || true"] });
    return {
      size,
      chunkSize,
      uploadMs: Math.round(upMs),
      uploadMiBs: Number((size / MiB / (upMs / 1000)).toFixed(2)),
      downloadMs: Math.round(downMs),
      downloadMiBs: Number((size / MiB / (downMs / 1000)).toFixed(2)),
      firstByteMs: firstByteAt ? Math.round(firstByteAt - downStart) : null,
      chunks: Math.ceil(size / chunkSize),
      clientRssDeltaMiB: Number(((process.memoryUsage().rss - before) / MiB).toFixed(1)),
      guestPeakKiB: usage.ok && usage.stdout.trim() ? Number(usage.stdout.trim().split("\n")[0]) : null,
      verified: true,
    };
  } finally {
    await sandbox.destroy().catch(() => undefined);
  }
}

const rows = [];
for (const size of sizes) rows.push(await run(size, 512 * 1024));
for (const chunkSize of chunkSizes) rows.push(await run(32 * MiB, chunkSize));
console.log(JSON.stringify(rows, null, 2));
await rm(dir, { recursive: true, force: true });
